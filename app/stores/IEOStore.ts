import { List, Set, Map, fromJS } from "immutable";
import alt from "alt-instance";
import { Store } from "alt-instance";
import { IEOActions } from "actions/IEOActions";
import { debugGen } from "utils//Utils";
import { AbstractStore } from "./AbstractStore";

import ls from "lib/common/localStorage";
const STORAGE_KEY = "__graphene__";
let ss = new ls(STORAGE_KEY);

const debug = debugGen("IEOStore");

type State = {
};

class GatewayStore extends AbstractStore<State> {
  state: State = {
    backedCoins: Map({
      JADE: JADE_COINS
    }),
    bridgeCoins: Map(fromJS(ss.get("bridgeCoins", {}))),
    bridgeInputs: ["btc", "dash", "eth", "steem"],
    login: { accountName: "", signer: "" },
    records: {
      total: 0,
      records: [],
      offset: 0,
      size: 20
    },
    down: Map({}),
    modals: Map(),
    depositInfo: {},
    withdrawInfo: {}
  };
  constructor() {
    super();
    this.bindListeners({
      handleDepositUpdate: GatewayActions.afterUpdateDepositInfo,
      handleWithdrawUpdate: GatewayActions.afterUpdateWithdrawInfo,
      handleLogin: GatewayActions.updateLogin,
      handleRecordsUpdate: GatewayActions.updateFundRecords,
      openModal: GatewayActions.openModal,
      closeModal: GatewayActions.closeModal
    });
  }

  handleDepositUpdate(depositInfo) {
    debug("Open: ", depositInfo);
    this.setState({
      depositInfo
    });
  }

  handleWithdrawUpdate(withdrawInfo) {
    this.setState({
      withdrawInfo
    });
  }

  handleLogin(login: LoginBody) {
    this.setState({
      login
    });
  }

  handleRecordsUpdate(records: FundRecordRes) {
    this.setState({
      records
    });
  }

  openModal(id) {
    this.setState({
      modals: this.state.modals.set(id, true)
    });
  }

  closeModal(id) {
    this.setState({
      modals: this.state.modals.set(id, false)
    });
  }
}
const StoreWrapper = alt.createStore(
  GatewayStore,
  "GatewayStore"
) as GatewayStore & Store<State>;
export { StoreWrapper as GatewayStore };

export default StoreWrapper;
