import Main "../backend/main";
import Memory "../backend/memory/evm_wallet/v1";
assert Memory.init().next_operation_id == 1;
