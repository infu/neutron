module {
    public func getNumber(x: actor { some_func : shared () -> async () }) : async () {
        await x.some_func();
        }
    }