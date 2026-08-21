import V1 "./v1";
import V2 "./v2";
module {
    public func migrate(old : V1.Mem) : V2.Mem {
        {
            var revision = old.revision;
            var negotiations = old.negotiations;
            var receipts = old.receipts;
            var signal_sequence = 0;
            var signals = [];
            var signal_receipts = [];
        }
    };
}
