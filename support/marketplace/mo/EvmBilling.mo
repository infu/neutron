// All rights reserved. See ../LICENSE.
import Billing "./Billing";
import Rpc "./EvmRpc";
import Types "./Types";

module {
  public type Fees = {
    prepare : Billing.Quote;
    verify : Billing.Quote;
    settle : Billing.Quote;
    cancel : Billing.Quote;
  };

  // Fixed checkout estimate, not a dynamic tariff. Anonymous EVM RPC cost
  // queries on 2026-09-10 quoted about 2.215B for the receipt and 22.934B for
  // a 256 KiB block response using these three providers. The block includes
  // transaction hashes, so a small header-only estimate is insufficient.
  // Cost queries in the adapter verify that each call fits its prepaid budget.
  // Provider prices changing never silently increase this customer's charge.
  public let verificationBudget : Nat = 50_000_000_000;
  public let rpcOptions : Rpc.Options = {
    providers = [#Ankr, #PublicNode, #Llama];
    receiptResponseBytes = 8_192;
    blockResponseBytes = 262_144;
    receiptCycles = 5_000_000_000;
    blockCycles = 45_000_000_000;
  };

  public func quote(schedule : Types.FeeSchedule) : Fees {
    let prepare = Billing.quote(schedule, #purchase, 0, 0);
    {
      prepare;
      verify = {
        prepare with
        processingCycles = prepare.processingCycles + verificationBudget;
        totalCycles = prepare.totalCycles + verificationBudget;
      };
      settle = Billing.quote(schedule, #withdraw, 0, 0);
      cancel = Billing.quote(schedule, #update, 0, 0);
    };
  };
}
