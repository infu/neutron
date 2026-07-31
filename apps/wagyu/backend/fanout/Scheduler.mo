module {
    public type Candidate = {
        job_id : Nat64;
        ready : Bool;
    };

    public type Input = {
        after_job_id : ?Nat64;
        // Ascending entries from the cursor to the end of the index. An
        // inclusive entry equal to after_job_id is allowed and is skipped.
        suffix : [Candidate];
        // Present only when the suffix iterator was exhausted before the
        // shared scan limit. The ascending head page may include the cursor
        // entry to close the circle, but entries above it are not examined.
        head : ?[Candidate];
        scan_limit : Nat;
    };

    public type Selection = {
        selected_job_id : ?Nat64;
        // Null resets the durable cursor after a full, short scan. Otherwise
        // this is either the selected job or the last job examined.
        next_after_job_id : ?Nat64;
    };

    // The caller supplies ascending, unique, already-bounded index pages.
    // Exactly one examination budget is shared by the suffix and wrapped
    // head, and no collection proportional to the full job index is built.
    public func selectNextReady(input : Input) : Selection {
        var examined = 0;
        var lastExamined = input.after_job_id;
        var selected : ?Nat64 = null;

        label suffix for (candidate in input.suffix.vals()) {
            if (examined >= input.scan_limit) break suffix;
            let strictlyAfter = switch (input.after_job_id) {
                case null true;
                case (?cursor) candidate.job_id > cursor;
            };
            if (strictlyAfter) {
                examined += 1;
                lastExamined := ?candidate.job_id;
                if (candidate.ready) {
                    selected := ?candidate.job_id;
                    break suffix;
                };
            };
        };

        if (
            selected == null and
            examined < input.scan_limit and
            input.after_job_id != null
        ) {
            switch (input.head) {
                case null {};
                case (?head) {
                    label wrap for (candidate in head.vals()) {
                        if (examined >= input.scan_limit) break wrap;
                        let atOrBefore = switch (input.after_job_id) {
                            case null false;
                            case (?cursor) candidate.job_id <= cursor;
                        };
                        if (atOrBefore) {
                            examined += 1;
                            lastExamined := ?candidate.job_id;
                            if (candidate.ready) {
                                selected := ?candidate.job_id;
                                break wrap;
                            };
                        } else {
                            break wrap;
                        };
                    };
                };
            };
        };

        switch (selected) {
            case (?jobId) {
                {
                    selected_job_id = ?jobId;
                    next_after_job_id = ?jobId;
                };
            };
            case null {
                {
                    selected_job_id = null;
                    next_after_job_id =
                        if (examined < input.scan_limit) {
                            null;
                        } else lastExamined;
                };
            };
        };
    };
};
