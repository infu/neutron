module {
    func some() : async () {
        let test = actor("aaaaa-aaa"): actor { anything : shared () -> async () };
    }
}