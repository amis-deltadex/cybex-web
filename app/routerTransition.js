import { Apis, Manager, ChainConfig } from "cybexjs-ws";
import { ChainStore } from "cybexjs";
import chainIds from "chain/chainIds";

// Stores
import iDB from "idb-instance";
import AccountRefsStore from "stores/AccountRefsStore";
import WalletManagerStore from "stores/WalletManagerStore";
import WalletDb from "stores/WalletDb";
import SettingsStore from "stores/SettingsStore";
import AccountStore from "stores/AccountStore";

import ls from "common/localStorage";

const STORAGE_KEY = "__graphene__";
const ss = new ls(STORAGE_KEY);

import counterpart from "counterpart";

// Actions
import PrivateKeyActions from "actions/PrivateKeyActions";
import SettingsActions from "actions/SettingsActions";
import notify from "actions/NotificationActions";

ChainStore.setDispatchFrequency(60);

/** RouterTransitioner is a helper class that facilitates connecting, switching and reconnecting
 *  to nodes.
 *
 *  @author Stefan Schiessl <stefan.schiessl@blockchainprojectsbv.com>
 */
class RouterTransitioner {
  constructor() {
    this._connectionManager;

    this._oldChain = null;

    // boolean flag if the lowest latency node should be autoselected
    this._autoSelection = null;

    this._connectInProgress = false;
    this._connectionStart = null;

    this._willTransitionToInProgress = false;

    // transitionDone is called within Promises etc., rebind it to always reference to RouterTransitioner object as
    // this
    this._transitionDone = this._transitionDone.bind(this);
  }

  /**
   * Is called once when router is initialized, and then if a connection error occurs or user manually
   * switches nodes
   *
   * @param callback argument as given by Route onEnter
   * @param appInit true when called via router, false false when node is manually selected in access settings
   * @returns {Promise}
   */
  willTransitionTo(appInit = true, statusCallback = () => {}) {
    if (this.isTransitionInProgress()) return;
    this.statusCallback = statusCallback;
    this._willTransitionToInProgress = true;

    return new Promise((resolve, reject) => {
      console.debug("Transition Start");
      // dict of apiServer url as key and the latency as value
      const apiLatencies = SettingsStore.getState().apiLatencies;
      let latenciesEstablished = Object.keys(apiLatencies).length > 0;

      let latencyChecks = ss.get("latencyChecks", 1);
      if (latencyChecks >= 5) {
        // every x connect attempts we refresh the api latency list
        // automatically
        ss.set("latencyChecks", 0);
        latenciesEstablished = false;
      } else {
        // otherwise increase the counter
        if (appInit) ss.set("latencyChecks", latencyChecks + 1);
      }
      console.debug("Transition To Get Urls");
      let urls = this._getNodesToConnectTo(false, apiLatencies);
      console.debug("Transition Got Urls");

      // set auto selection flag
      this._autoSelection =
        SettingsStore.getSetting("apiServer").indexOf(
          "fake.automatic-selection"
        ) !== -1;
      console.debug("Transition Set AutoSelection");

      this._initConnectionManager(urls);

      console.debug("Transition Connection Manager Inited");
      if (!latenciesEstablished || Object.keys(apiLatencies).length < 10) {
        console.debug("update Tras");
        this._willTransitionToInProgress = counterpart.translate(
          "settings.ping"
        );
        this.statusCallback(counterpart.translate("app_init.check_latency"));
        let start = Date.now();
        this.doLatencyUpdate(true, null, appInit)
          .then(res => {
            console.debug("Latency: ", Date.now() - start, res);
            return res;
          })
          .then(this._initiateConnection.bind(this, appInit, resolve, reject))
          .catch(err => {
            console.log("catch doLatency", err);
          });
      } else {
        console.debug("update latenciesEstablished");

        this._initiateConnection(appInit, resolve, reject);
      }
    });
  }

  /**
   * Called when connection to a node has been established
   *
   * @param resolveOrReject
   * @private
   */
  _transitionDone(resolveOrReject) {
    resolveOrReject();
    this._willTransitionToInProgress = false;
  }

  /**
   * Updates the latency of all target nodes
   *
   * @param refresh boolean true reping all existing nodes
   *                        false only reping all reachable nodes
   * @returns {Promise}
   */
  doLatencyUpdate(refresh = true, range = null, race = false) {
    return new Promise((resolve, reject) => {
      // if for some reason this method is called before connections are setup via willTransitionTo,
      // initialize the manager
      console.debug("Latency Update", "Start");
      if (this._connectionManager == null) {
        this._initConnectionManager();
      }
      console.debug("Latency Update", "Manager Inited");
      if (refresh) {
        console.debug("Latency Update", "Refresh");
        this._connectionManager.urls = this._getNodesToConnectTo(true);
      }
      let url = this._connectionManager.url;
      let urls = this._connectionManager.urls;
      let current = 0;

      if (range == null) {
        range = this._connectionManager.urls.length;
      } else {
        SettingsActions.updateLatencies({});
      }
      console.debug("Latency Update", "After Set Range");

      function local_ping(thiz, range = null) {
        console.debug("Latency Update local_ping", "Start", "Range", range);
        if (current < urls.length) {
          thiz._connectionManager.url = urls[current];
          thiz._connectionManager.urls = urls.slice(
            current + 1,
            current + range
          );
          console.log(
            current,
            range,
            thiz._connectionManager.url,
            thiz._connectionManager.urls
          );
          thiz._connectionManager
            .checkConnections("", "", undefined, undefined, race)
            .then(res => {
              console.log(res);
              // update the latencies object
              const apiLatencies = SettingsStore.getState().apiLatencies;
              for (var nodeUrl in res) {
                apiLatencies[nodeUrl] = res[nodeUrl];
              }
              SettingsActions.updateLatencies(apiLatencies);
            })
            .catch(err => {
              console.log("doLatencyUpdate error", err);
            })
            .finally(() => {
              if (race) {
                console.debug("App Init done_ping");
                done_pinging(thiz);
              } else {
                current = current + range;
                setTimeout(() => {
                  local_ping(thiz, range);
                }, 50);
              }
            });
        } else {
          done_pinging(thiz);
        }
      }

      function done_pinging(thiz) {
        thiz._connectionManager.url = url;
        // resort the api nodes with the new pings
        thiz._connectionManager.urls = thiz._getNodesToConnectTo();
        resolve();
      }
      local_ping(this, range);
    });
  }

  _initConnectionManager(urls = null) {
    if (urls == null) {
      urls = this._getNodesToConnectTo(true);
    }
    // decide where to connect to first
    let connectionString = this._getFirstToTry(urls);
    this._willTransitionToInProgress = connectionString;

    this._connectionManager = new Manager({
      url: connectionString,
      urls: urls,
      closeCb: this._onConnectionClose.bind(this),
      // Todos
      optionalApis: { enableOrders: false },
      urlChangeCallback: url => {
        console.log(
          "fallback to new url:",
          url,
          "old",
          this._willTransitionToInProgress
        );
        /* Update connection status */
        this.statusCallback(
          counterpart.translate("app_init.connecting", { server: url })
        );
        this._willTransitionToInProgress = url;
        SettingsActions.changeSetting({
          setting: "activeNode",
          value: url
        });
      }
    });
  }

  _onConnectionClose() {
    // Possibly do something about auto reconnect attempts here
  }

  isAutoSelection() {
    return this._autoSelection;
  }

  isTransitionInProgress() {
    return !!this._willTransitionToInProgress;
  }

  getTransitionTarget() {
    if (this.isTransitionInProgress()) return this._willTransitionToInProgress;
    return null;
  }

  /**
   *
   * @param apiNodeUrl the url of the target node, e.g. wss://eu.nodes.bitshares.ws
   * @returns {boolean} true the security matches, meaning that we either have:
   *                         - user connected via http to the wallet and target node is ws:// or wss://
   *                         - user connected via https and target node is wss://
   *                    false user tries to connect to ws:// node via a wallet opened in https
   * @private
   */
  _apiUrlSecuritySuitable(apiNodeUrl) {
    if (window.location.protocol === "https:") {
      return apiNodeUrl.indexOf("ws://") == -1;
    } else {
      return true;
    }
  }

  _isTestNet(url) {
    return url.indexOf("testnet") !== -1;
  }

  /**
   * Returns a list of all configured api nodes
   *
   * @returns list of dictionaries with keys: url, hidden, location
   */
  getAllApiServers() {
    return SettingsStore.getState().defaults.apiServer;
  }

  /**
   * Returns a list of all nodes as given by the flags, always sorted
   *
   * @param latenciesMap (default null) map of all latencies, if null taken from settings
   * @param latencies (default true) if true, and latenciesMap has entries, then filter out all without latency
   * @param hidden (default false) if false, filter out all hidden nodes
   * @param unsuitableSecurity (default false) if false, filter out all with unsuitable security
   * @param testNet (default false) if false, filter out all testnet nodes
   *
   * @returns list of viable api nodes (with above filters applied)
   *          if latencies is given, the nodes are sorted with descending latency (index 0 fasted one)
   */
  getNodes(
    latenciesMap = null,
    latencies = true,
    hidden = false,
    unsuitableSecurity = false,
    testNet = false
  ) {
    if (latencies) {
      if (latenciesMap == null) {
        latenciesMap = SettingsStore.getState().apiLatencies;
      }
      // if there are no latencies, return all that are left after filtering
      latencies = Object.keys(latenciesMap).length > 0;
    }
    let filtered = this.getAllApiServers().filter(a => {
      // Skip hidden nodes
      if (!hidden && a.hidden) return false;

      // do not automatically connect to TESTNET
      if (!testNet && this._isTestNet(a.url)) return false;

      // remove the automatic fallback dummy url
      if (a.url.indexOf("fake.automatic-selection") !== -1) return false;

      // Remove insecure websocket urls when using secure protocol
      if (!unsuitableSecurity && !this._apiUrlSecuritySuitable(a.url)) {
        return false;
      }
      // we don't know any latencies, return all
      if (!latencies) return true;

      // only keep the ones we were able to connect to
      return !!latenciesMap[a.url];
    });
    // create more info in the entries
    filtered = filtered.map(a => {
      let newEntry = {
        name: a.location || "Unknown location",
        url: a.url,
        hidden: !!a.hidden
      };
      if (latenciesMap != null && a.url in latenciesMap) {
        newEntry.latency = latenciesMap[a.url];
      } else {
        newEntry.latency = null;
      }
      return newEntry;
    });
    if (!latencies) {
      return filtered;
    }
    // now sort
    filtered = filtered.sort((a, b) => {
      if (!latencies) {
        if (this._isTestNet(a.url)) return -1;
        return 1;
      } else {
        // if both have latency, sort according to that
        if (a.latency != null && b.latency != null) {
          return a.latency - b.latency;
          // sort testnet to the bottom
        } else if (a.latency == null && b.latency == null) {
          if (this._isTestNet(a.url)) return -1;
          return 1;
          // otherwise prefer the pinged one
        } else if (a.latency != null && b.latency == null) {
          return -1;
        } else if (b.latency != null && a.latency == null) {
          return 1;
        }
        return 0;
      }
    });
    // remove before release
    return filtered;
  }

  /**
   * Returns a list of viable api nodes that we consider connecting to
   *
   * @param all (default false) if true, all nodes are returned
   * @param latenciesMap (default null)
   * @returns see getNodes
   */
  _getNodesToConnectTo(all = false, latenciesMap = null) {
    return this.getNodes(latenciesMap, !all).map(a => a.url); // drop location, only urls in list
  }

  /**
   * Returns the the one last url node connected to, with fallback the lowest latency one if
   *    > there was no last connection
   *    > if security is not suitable fallback to the lowest latency one
   *    > if autoSelection is true
   *
   * @param urls list of string, list of node urls suitable for connecting to
   * @returns connectionString
   * @private
   */
  _getFirstToTry(urls) {
    let connectionString = SettingsStore.getSetting("apiServer");
    // fallback to the best of the pre-defined URLs ...

    // ... if there is no preset connectionString fallback to lowest latency
    if (!connectionString) connectionString = urls[0];

    // ... if auto selection is on (is also ensured in initConnection, but we don't want to ping
    //     a unreachable url)
    if (this.isAutoSelection()) {
      connectionString = urls[0];
      console.log("auto selecting to " + connectionString);
    }

    // ... if insecure websocket url is used when using secure protocol
    //    (the list urls only contains matching ones)
    if (!this._apiUrlSecuritySuitable(connectionString))
      connectionString = urls[0];

    return connectionString;
  }

  /**
   * Returns the implementation of the db as loaded by indexeddbshim node module
   *
   * @returns indexedDB instance
   * @private
   */
  _getIndexDBImpl() {
    return window.openDatabase ? shimIndexedDB || indexedDB : indexedDB;
  }

  /**
   * Does the actual connection to the node, with fallback if appInit, otherwise attempts reconnect
   *
   * @param appInit  see willTransitionTo
   * @private
   */
  _initiateConnection(appInit, resolve, reject) {
    this._willTransitionToInProgress = this._connectionManager.url;
    this._connectionStart = new Date().getTime();
    console.debug("Init Connection: ", appInit);
    if (appInit) {
      // only true if app is initialized
      this.statusCallback(
        counterpart.translate("app_init.connecting", {
          server: this._connectionManager.url
        })
      );
      this._connectionManager
        .connectWithFallback(true)
        .then(() => {
          if (!this.isAutoSelection()) {
            SettingsActions.changeSetting({
              setting: "apiServer",
              value: this._connectionManager.url
            });
          }
          console.debug("Connect Done");
          this._onConnect(resolve, reject);
        })
        .catch(error => {
          console.error(
            "----- App.willTransitionTo error ----->",
            error,
            new Error().stack
          );
          if (error.name === "InvalidStateError") {
            alert(
              "Can't access local storage.\nPlease make sure your browser is not in private/incognito mode."
            );
          } else {
            this._transitionDone(reject);
          }
        });
    } else {
      // in case switches manually, reset the settings so we dont connect to
      // a faulty node twice. If connection is established, onConnect sets the settings again
      if (!this.isAutoSelection()) {
        SettingsActions.changeSetting({
          setting: "apiServer",
          value: ""
        });
      }
      this._attemptReconnect(resolve, reject);
    }
  }

  /**
   * Reconnect on error
   *
   * @param failingNodeUrl string url of node that failed
   * @param err exception that occured
   * @private
   */
  _onResetError(failingNodeUrl, err) {
    console.error("onResetError:", err, failingNodeUrl);
    this._willTransitionToInProgress = false;
    this._oldChain = "old";
    notify.addNotification({
      message: counterpart.translate("settings.connection_error", {
        url: failingNodeUrl || "",
        error: err
      }),
      level: "error",
      autoDismiss: 10
    });
    return Apis.close().then(() => {
      return this.willTransitionTo(true);
    });
  }

  /**
   * Resets the api and attempts a reconnect
   *
   * @private
   */
  _attemptReconnect(resolve, reject) {
    this._oldChain = "old";
    Apis.reset(this._connectionManager.url, true, undefined, {
      // Todos
      enableOrders: false
    }).then(instance => {
      instance.init_promise
        .then(this._onConnect.bind(this, resolve, reject))
        .catch(this._onResetError.bind(this, this._connectionManager.url));
    });
  }

  /**
   * Called when a connection has been established
   *
   * @returns
   * @private
   */
  _onConnect(resolve, reject) {
    // console.log(new Date().getTime(), "routerTransition onConnect", caller, "_connectInProgress", _connectInProgress);
    if (this._connectInProgress) {
      console.error("MULTIPLE CONNECT IN PROGRESS");
      return;
    }
    this.statusCallback(counterpart.translate("app_init.database"));
    this._connectInProgress = true;
    if (Apis.instance()) {
      if (!Apis.instance().orders_api())
        console.log(`${Apis.instance().url} does not support the orders api`);
      let currentUrl = Apis.instance().url;
      SettingsActions.changeSetting({
        setting: "activeNode",
        value: currentUrl
      });
      if (!this.isAutoSelection())
        SettingsActions.changeSetting({
          setting: "apiServer",
          value: currentUrl
        });
      const apiLatencies = SettingsStore.getState().apiLatencies;
      if (!(currentUrl in apiLatencies)) {
        // the ping calculated here does not reflect the same ping as in checkConnection from ConnectionManager,
        // thus updating would be "unfair" and also is confusing in UI
        apiLatencies[currentUrl] = new Date().getTime() - this._connectionStart;
        SettingsActions.updateLatencies(apiLatencies);
      }
    }
    const currentChain = Apis.instance().chain_id;
    const chainChanged = this._oldChain !== currentChain;
    this._oldChain = currentChain;
    var dbPromise = Promise.resolve();
    try {
      if (chainChanged) {
        iDB.close();
        dbPromise = iDB.init_instance(this._getIndexDBImpl()).init_promise;
      }
    } catch (err) {
      console.error("db init error:", err);
      this._connectInProgress = false;
      return this._transitionDone(reject);
    }

    return Promise.all([dbPromise, SettingsStore.init()])
      .then(() => {
        let chainStoreResetPromise = chainChanged
          ? ChainStore.resetCache(false)
          : Promise.resolve();
        return chainStoreResetPromise
          .then(() => {
            return Promise.all([
              PrivateKeyActions.loadDbData().then(() => {
                return AccountRefsStore.loadDbData();
              }),
              WalletDb.loadDbData()
                .then(() => {
                  if (chainChanged) {
                    AccountStore.reset();
                    return AccountStore.loadDbData(currentChain).catch(err => {
                      console.error(err);
                    });
                  }
                })
                .catch(error => {
                  console.error(
                    "----- WalletDb.willTransitionTo error ----->",
                    error
                  );
                  this._transitionDone(reject);
                }),
              WalletManagerStore.init()
            ]).then(() => {
              this._connectInProgress = false;
              SettingsActions.changeSetting({
                setting: "activeNode",
                value: this._connectionManager.url
              });
              this._transitionDone(resolve);
            });
          })
          .catch(err => {
            this._connectInProgress = false;
            this._transitionDone(reject.bind(this, err));
          });
      })
      .catch(err => {
        console.error(err);
        this._connectInProgress = false;
        this._transitionDone(reject);
      });
  }
}

// this makes routerTransitioner a Singleton
export let routerTransitioner = new RouterTransitioner();
export default routerTransitioner.willTransitionTo.bind(routerTransitioner);
