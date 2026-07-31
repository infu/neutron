import Runtime "mo:core/Runtime";

import Scheduler "../../backend/fanout/Scheduler";

func candidate(jobId : Nat64, ready : Bool) : Scheduler.Candidate {
    {
        job_id = jobId;
        ready;
    };
};

func expect(
    input : Scheduler.Input,
    selectedJobId : ?Nat64,
    nextAfterJobId : ?Nat64,
) {
    let result = Scheduler.selectNextReady(input);
    if (result.selected_job_id != selectedJobId) {
        Runtime.trap("fanout scheduler selected the wrong job");
    };
    if (result.next_after_job_id != nextAfterJobId) {
        Runtime.trap("fanout scheduler advanced the cursor incorrectly");
    };
};

expect(
    {
        after_job_id = null;
        suffix = [
            candidate(1, false),
            candidate(2, true),
            candidate(3, true),
        ];
        head = null;
        scan_limit = 3;
    },
    ?2,
    ?2,
);

// Map.entriesFrom is inclusive. The cursor row is not examined on the suffix,
// so the next ready job wins without consuming budget for the equal row.
expect(
    {
        after_job_id = ?2;
        suffix = [
            candidate(2, true),
            candidate(3, false),
            candidate(4, true),
        ];
        head = ?[candidate(1, true), candidate(2, true)];
        scan_limit = 2;
    },
    ?4,
    ?4,
);

// Closing the circular scan includes the original cursor exactly once. A lone
// ready job therefore runs every invocation instead of spending alternate
// invocations merely resetting the cursor.
expect(
    {
        after_job_id = ?7;
        suffix = [candidate(7, true)];
        head = ?[candidate(7, true)];
        scan_limit = 1;
    },
    ?7,
    ?7,
);

// Two ready jobs advance fairly in both the forward and wrapped directions.
expect(
    {
        after_job_id = ?1;
        suffix = [candidate(1, true), candidate(2, true)];
        head = ?[candidate(1, true)];
        scan_limit = 2;
    },
    ?2,
    ?2,
);
expect(
    {
        after_job_id = ?2;
        suffix = [candidate(2, true)];
        head = ?[candidate(1, true), candidate(2, true)];
        scan_limit = 2;
    },
    ?1,
    ?1,
);

// The suffix and head share one budget. Reaching it on the suffix persists the
// last examined ID and does not inspect the ready head row.
expect(
    {
        after_job_id = ?2;
        suffix = [
            candidate(2, true),
            candidate(3, false),
            candidate(4, false),
        ];
        head = ?[candidate(1, true), candidate(2, true)];
        scan_limit = 2;
    },
    null,
    ?4,
);

// If a short full circle has no ready row, the durable cursor is reset.
expect(
    {
        after_job_id = ?2;
        suffix = [candidate(2, false), candidate(3, false)];
        head = ?[candidate(1, false), candidate(2, false)];
        scan_limit = 4;
    },
    null,
    null,
);

// A deleted cursor need not be present in either page; wrapping still starts
// at the ordered head and rows above the old cursor are not revisited.
expect(
    {
        after_job_id = ?5;
        suffix = [candidate(7, false)];
        head = ?[
            candidate(1, true),
            candidate(3, false),
            candidate(7, true),
        ];
        scan_limit = 3;
    },
    ?1,
    ?1,
);

// There is no circular wrap without an established cursor.
expect(
    {
        after_job_id = null;
        suffix = [candidate(1, false)];
        head = ?[candidate(2, true)];
        scan_limit = 2;
    },
    null,
    null,
);
