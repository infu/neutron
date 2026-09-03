import Iter "mo:core/Iter";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import Text "mo:core/Text";
import CapabilityScope "../capabilities/Scope";
import CapabilityTypes "../capabilities/Types";
import Types "Types";

module {
    let MAX_PER_APP = 256;
    // Keep in sync with BACKEND_CALLS_MAX_INSTALL_RESERVATIONS_GLOBAL for
    // compiler-owned defaults; runtime reservations share the same pool.
    let MAX_TOTAL = 2_048;

    type Ownership = {
        #none;
        #owner : CapabilityTypes.AppScope;
        #conflict;
    };

    type ReservationOwnership = {
        #none;
        #reservation : Types.Reservation;
        #conflict;
    };

    public func isPristine(mem : Types.Memory) : Bool {
        mem.next_id == 1 and Map.size(mem.reservations) == 0;
    };

    public func list(mem : Types.Memory) : [Types.ReservationSummary] {
        let result = List.empty<Types.ReservationSummary>();
        for (reservation in Map.values(mem.reservations)) {
            if (not isInstallClaim(reservation)) {
                List.add(result, summary(reservation));
            };
        };
        List.toArray(result);
    };

    public func listApp(
        mem : Types.Memory,
        appScope : CapabilityTypes.AppScope,
    ) : [Types.ReservationSummary] {
        let result = List.empty<Types.ReservationSummary>();
        for (reservation in Map.values(mem.reservations)) {
            if (
                not isInstallClaim(reservation) and
                CapabilityScope.equal(reservation.app_scope, appScope)
            ) {
                List.add(result, summary(reservation));
            };
        };
        List.toArray(result);
    };

    public func apply(
        mem : Types.Memory,
        appScope : CapabilityTypes.AppScope,
        actions : [Types.ReservationAction],
        caller : Principal,
        now : Nat64,
    ) : ?[Types.ReservationSummary] {
        let working : Types.Memory = {
            var next_id = mem.next_id;
            reservations = Map.clone(mem.reservations);
        };
        for (action in actions.vals()) {
            switch (action) {
                case (#release(scope)) {
                    ignore removeReservationScope(working, appScope, scope);
                };
                case (#reserve(_)) {};
            };
        };
        for (action in actions.vals()) {
            switch (action) {
                case (#reserve(scope)) {
                    let ?_ = put(working, appScope, scope, caller, now) else {
                        return null;
                    };
                };
                case (#release(_)) {};
            };
        };

        mem.next_id := working.next_id;
        Map.clear(mem.reservations);
        for ((id, reservation) in Map.entries(working.reservations)) {
            Map.add(mem.reservations, Nat.compare, id, reservation);
        };
        ?listApp(mem, appScope);
    };

    public func put(
        mem : Types.Memory,
        appScope : CapabilityTypes.AppScope,
        scope : Types.ReservationScope,
        caller : Principal,
        now : Nat64,
    ) : ?Types.ReservationSummary {
        if (conflicts(mem, appScope, scope)) return null;
        for (reservation in Map.values(mem.reservations)) {
            if (
                CapabilityScope.equal(reservation.app_scope, appScope) and
                scopeEqual(reservation.scope, scope)
            ) return ?summary(reservation);
        };
        if (Map.size(mem.reservations) >= MAX_TOTAL) return null;
        var appCount = 0;
        for (reservation in Map.values(mem.reservations)) {
            if (CapabilityScope.equal(reservation.app_scope, appScope)) {
                appCount += 1;
            };
        };
        if (appCount >= MAX_PER_APP) return null;

        let reservation : Types.Reservation = {
            id = mem.next_id;
            app_scope = appScope;
            scope;
            created_at = now;
            created_by = caller;
        };
        mem.next_id += 1;
        Map.add(mem.reservations, Nat.compare, reservation.id, reservation);
        ?summary(reservation);
    };

    public func remove(mem : Types.Memory, id : Nat) : Bool {
        Map.delete(mem.reservations, Nat.compare, id);
    };

    public func removeActive(mem : Types.Memory, id : Nat) : Bool {
        let ?reservation = Map.get(
            mem.reservations,
            Nat.compare,
            id,
        ) else return false;
        if (isInstallClaim(reservation)) return false;
        Map.delete(mem.reservations, Nat.compare, id);
    };

    public func removeReservationScope(
        mem : Types.Memory,
        appScope : CapabilityTypes.AppScope,
        scope : Types.ReservationScope,
    ) : Bool {
        var found : ?Nat = null;
        label reservations for ((id, reservation) in Map.entries(mem.reservations)) {
            if (
                CapabilityScope.equal(reservation.app_scope, appScope) and
                scopeEqual(reservation.scope, scope)
            ) {
                found := ?id;
                break reservations;
            };
        };
        switch (found) {
            case (?id) Map.delete(mem.reservations, Nat.compare, id);
            case null false;
        };
    };

    public func removeAppScope(
        mem : Types.Memory,
        appScope : CapabilityTypes.AppScope,
    ) : () {
        removeWhere(mem, func(reservation) {
            CapabilityScope.equal(reservation.app_scope, appScope)
        });
    };

    public func removeIncompatible(
        mem : Types.Memory,
        supports : (CapabilityTypes.AppScope, Text) -> Bool,
    ) : () {
        removeWhere(mem, func(reservation) {
            not isInstallClaim(reservation) and
            not supports(reservation.app_scope, scopeKind(reservation.scope))
        });
    };

    // Installation claims live in the existing stable reservation map so an
    // old Kernel can reserve a target deployment's defaults before queuing the
    // one-way self-upgrade. Installation uid zero is forbidden for every real
    // app scope. Claims are therefore durable, but are never exposed by list()
    // and never participate in allows().
    public func prepareInstallClaims(
        mem : Types.Memory,
        plans : [Types.InstallReservationPlan],
        caller : Principal,
        now : Nat64,
    ) : Bool {
        if (hasInstallClaims(mem)) {
            return installClaimsEqual(mem, plans);
        };

        let working : Types.Memory = {
            var next_id = mem.next_id;
            reservations = Map.clone(mem.reservations);
        };
        var additionalGlobal = 0;
        for (plan in plans.vals()) {
            var finalAppCount = activeAppCount(working, plan.app_scope);
            for (scope in plan.reservations.vals()) {
                if (installClaimForScope(working, scope) != null) {
                    return false;
                };
                switch (activeReservationOwnership(working, scope)) {
                    case (#none) {
                        additionalGlobal += 1;
                        finalAppCount += 1;
                    };
                    case (#conflict) return false;
                    case (#reservation(reservation)) {
                        // A replacement may retain a reservation already
                        // owned by the same logical app. It may never credit or
                        // steal an unrelated app's reservation.
                        if (
                            reservation.app_scope.app_id !=
                            plan.app_scope.app_id
                        ) return false;
                        if (not CapabilityScope.equal(
                            reservation.app_scope,
                            plan.app_scope,
                        )) {
                            finalAppCount += 1;
                        };
                    };
                };
                if (finalAppCount > MAX_PER_APP) return false;
                let claim : Types.Reservation = {
                    id = working.next_id;
                    app_scope = installClaimScope(plan.app_scope.app_id);
                    scope;
                    created_at = now;
                    created_by = caller;
                };
                working.next_id += 1;
                Map.add(
                    working.reservations,
                    Nat.compare,
                    claim.id,
                    claim,
                );
            };
        };
        if (activeCount(mem) + additionalGlobal > MAX_TOTAL) return false;

        copyMemory(mem, working);
        true;
    };

    // The target actor's compiler-owned declarations are authoritative. Work
    // on a private clone, discard every inert predecessor claim, and
    // materialize only those exact defaults. Honest preflight makes this path
    // ready; a mismatched/omitted plan can still self-repair when the frozen
    // active table has room. A real conflict returns false without mutating
    // stable state or trapping the already-running target.
    public func canFinalizeInstallReservations(
        mem : Types.Memory,
        plans : [Types.InstallReservationPlan],
        supports : (CapabilityTypes.AppScope, Text) -> Bool,
        caller : Principal,
        now : Nat64,
    ) : Bool {
        reconcileInstallReservations(
            mem,
            plans,
            supports,
            caller,
            now,
            false,
        );
    };

    public func finalizeInstallReservations(
        mem : Types.Memory,
        plans : [Types.InstallReservationPlan],
        supports : (CapabilityTypes.AppScope, Text) -> Bool,
        caller : Principal,
        now : Nat64,
    ) : Bool {
        reconcileInstallReservations(
            mem,
            plans,
            supports,
            caller,
            now,
            true,
        );
    };

    func reconcileInstallReservations(
        mem : Types.Memory,
        plans : [Types.InstallReservationPlan],
        supports : (CapabilityTypes.AppScope, Text) -> Bool,
        caller : Principal,
        now : Nat64,
        persist : Bool,
    ) : Bool {
        let working = normalizedInstallMemory(mem, supports);

        for (plan in plans.vals()) {
            for (scope in plan.reservations.vals()) {
                switch (activeReservationOwnership(working, scope)) {
                    case (#conflict) return false;
                    case (#reservation(active)) {
                        if (
                            active.app_scope.app_id !=
                            plan.app_scope.app_id
                        ) return false;
                        if (not CapabilityScope.equal(
                            active.app_scope,
                            plan.app_scope,
                        )) {
                            if (
                                activeAppCount(working, plan.app_scope) >=
                                MAX_PER_APP
                            ) return false;
                            Map.add(
                                working.reservations,
                                Nat.compare,
                                active.id,
                                {
                                    active with
                                    app_scope = plan.app_scope;
                                },
                            );
                        };
                    };
                    case (#none) {
                        if (
                            activeCount(working) >= MAX_TOTAL or
                            activeAppCount(working, plan.app_scope) >=
                                MAX_PER_APP
                        ) return false;
                        switch (installClaimForAppScope(
                            mem,
                            plan.app_scope.app_id,
                            scope,
                        )) {
                            case (?claim) {
                                // Reuse the predecessor's durable receipt so
                                // audit identity reflects admission time.
                                Map.add(
                                    working.reservations,
                                    Nat.compare,
                                    claim.id,
                                    {
                                        claim with
                                        app_scope = plan.app_scope;
                                    },
                                );
                            };
                            case null {
                                // Mismatch recovery: the compiled target may
                                // add an omitted default only when the frozen
                                // table independently proves it is safe.
                                let ?_ = put(
                                    working,
                                    plan.app_scope,
                                    scope,
                                    caller,
                                    now,
                                ) else return false;
                            };
                        };
                    };
                };
            };
        };
        if (persist) copyMemory(mem, working);
        true;
    };

    // Return at most one deterministic recovery candidate. Recomputing after
    // each release keeps the destructive edge narrow: every accepted row is
    // proven to advance the authoritative target plan, and a row that the
    // plan would immediately recreate is never offered.
    public func installRecoveryBlockers(
        mem : Types.Memory,
        plans : [Types.InstallReservationPlan],
        supports : (CapabilityTypes.AppScope, Text) -> Bool,
    ) : [Types.PendingReservationBlocker] {
        // Do not offer a destructive recovery edge for a target that can never
        // fit or that assigns one reservation scope to multiple apps. Honest
        // preparation already rejects these plans, but the compiled target is
        // authoritative and may differ from a predecessor-supplied plan.
        if (not recoveryPlansFeasible(plans)) return [];

        let working = normalizedInstallMemory(mem, supports);

        // Resolve ownership defects before capacity. This also ensures the
        // later "required row" test sees at most one reusable owner for every
        // desired scope.
        for (plan in plans.vals()) {
            for (scope in plan.reservations.vals()) {
                switch (activeReservationOwnership(working, scope)) {
                    case (#none) {};
                    case (#reservation(active)) {
                        if (
                            active.app_scope.app_id !=
                            plan.app_scope.app_id
                        ) {
                            return [recoveryBlocker(
                                active,
                                #scope_conflict,
                            )];
                        };
                    };
                    case (#conflict) {
                        let ?candidate = scopeConflictCandidate(
                            working,
                            plan.app_scope,
                            scope,
                        ) else return [];
                        return [recoveryBlocker(
                            candidate,
                            #scope_conflict,
                        )];
                    };
                };
            };
        };

        for (plan in plans.vals()) {
            for (scope in plan.reservations.vals()) {
                switch (activeReservationOwnership(working, scope)) {
                    case (#conflict) return [];
                    case (#reservation(active)) {
                        if (
                            active.app_scope.app_id !=
                            plan.app_scope.app_id
                        ) return [];
                        if (not CapabilityScope.equal(
                            active.app_scope,
                            plan.app_scope,
                        )) {
                            if (
                                activeAppCount(working, plan.app_scope) >=
                                MAX_PER_APP
                            ) {
                                let ?candidate = appCapacityCandidate(
                                    working,
                                    plan,
                                ) else return [];
                                return [recoveryBlocker(
                                    candidate,
                                    #app_capacity,
                                )];
                            };
                            Map.add(
                                working.reservations,
                                Nat.compare,
                                active.id,
                                {
                                    active with
                                    app_scope = plan.app_scope;
                                },
                            );
                        };
                    };
                    case (#none) {
                        if (
                            activeAppCount(working, plan.app_scope) >=
                            MAX_PER_APP
                        ) {
                            let ?candidate = appCapacityCandidate(
                                working,
                                plan,
                            ) else return [];
                            return [recoveryBlocker(
                                candidate,
                                #app_capacity,
                            )];
                        };
                        if (activeCount(working) >= MAX_TOTAL) {
                            let ?candidate = globalCapacityCandidate(
                                working,
                                plans,
                            ) else return [];
                            return [recoveryBlocker(
                                candidate,
                                #global_capacity,
                            )];
                        };
                        let ?_ = put(
                            working,
                            plan.app_scope,
                            scope,
                            Principal.anonymous(),
                            0,
                        ) else return [];
                    };
                };
            };
        };
        [];
    };

    func normalizedInstallMemory(
        mem : Types.Memory,
        supports : (CapabilityTypes.AppScope, Text) -> Bool,
    ) : Types.Memory {
        let working : Types.Memory = {
            var next_id = mem.next_id;
            reservations = Map.clone(mem.reservations);
        };
        removeInstallClaims(working);
        removeIncompatible(working, supports);
        working;
    };

    public func removeInstallClaims(mem : Types.Memory) : () {
        removeWhere(mem, isInstallClaim);
    };

    public func hasInstallClaims(mem : Types.Memory) : Bool {
        for (reservation in Map.values(mem.reservations)) {
            if (isInstallClaim(reservation)) return true;
        };
        false;
    };

    public func allows(
        mem : Types.Memory,
        appScope : CapabilityTypes.AppScope,
        canister : Principal,
        method : Text,
    ) : Bool {
        var allowed = false;
        switch (owner(mem, func(reservation) {
            switch (reservation.scope) {
                case (#principal(principal)) Principal.equal(principal, canister);
                case (_) false;
            };
        })) {
            case (#owner(ownerScope)) {
                if (CapabilityScope.equal(ownerScope, appScope)) allowed := true;
            };
            case (#conflict) return false;
            case (#none) {};
        };
        switch (owner(mem, func(reservation) {
            switch (reservation.scope) {
                case (#method(name)) name == method;
                case (_) false;
            };
        })) {
            case (#owner(ownerScope)) {
                if (CapabilityScope.equal(ownerScope, appScope)) allowed := true;
            };
            case (#conflict) return false;
            case (#none) {};
        };
        switch (owner(mem, func(reservation) {
            switch (reservation.scope) {
                case (#exact(scope)) {
                    Principal.equal(scope.principal, canister) and scope.method == method;
                };
                case (_) false;
            };
        })) {
            case (#owner(ownerScope)) {
                if (CapabilityScope.equal(ownerScope, appScope)) allowed := true;
            };
            case (#conflict) return false;
            case (#none) {};
        };
        allowed;
    };

    public func conflicts(
        mem : Types.Memory,
        appScope : CapabilityTypes.AppScope,
        scope : Types.ReservationScope,
    ) : Bool {
        for (reservation in Map.values(mem.reservations)) {
            if (
                not CapabilityScope.equal(reservation.app_scope, appScope) and
                scopeEqual(reservation.scope, scope)
            ) return true;
        };
        false;
    };

    public func summary(reservation : Types.Reservation) : Types.ReservationSummary {
        switch (reservation.scope) {
            case (#exact(scope)) {
                {
                    id = reservation.id;
                    app_id = reservation.app_scope.app_id;
                    installation_uid = reservation.app_scope.installation_uid;
                    scope_kind = "exact";
                    principal = ?scope.principal;
                    method = ?scope.method;
                    created_at = reservation.created_at;
                    created_by = reservation.created_by;
                };
            };
            case (#principal(principal)) {
                {
                    id = reservation.id;
                    app_id = reservation.app_scope.app_id;
                    installation_uid = reservation.app_scope.installation_uid;
                    scope_kind = "principal";
                    principal = ?principal;
                    method = null;
                    created_at = reservation.created_at;
                    created_by = reservation.created_by;
                };
            };
            case (#method(method)) {
                {
                    id = reservation.id;
                    app_id = reservation.app_scope.app_id;
                    installation_uid = reservation.app_scope.installation_uid;
                    scope_kind = "method";
                    principal = null;
                    method = ?method;
                    created_at = reservation.created_at;
                    created_by = reservation.created_by;
                };
            };
        };
    };

    public func scopeKind(scope : Types.ReservationScope) : Text {
        switch (scope) {
            case (#exact(_)) "exact";
            case (#principal(_)) "principal";
            case (#method(_)) "method";
        };
    };

    public func scopeEqual(left : Types.ReservationScope, right : Types.ReservationScope) : Bool {
        switch (left, right) {
            case (#exact(a), #exact(b)) {
                Principal.equal(a.principal, b.principal) and a.method == b.method;
            };
            case (#principal(a), #principal(b)) Principal.equal(a, b);
            case (#method(a), #method(b)) a == b;
            case (_) false;
        };
    };

    func owner(mem : Types.Memory, matches : Types.Reservation -> Bool) : Ownership {
        var resolved : Ownership = #none;
        for (reservation in Map.values(mem.reservations)) {
            if (not isInstallClaim(reservation) and matches(reservation)) {
                switch (resolved) {
                    case (#none) resolved := #owner(reservation.app_scope);
                    case (#owner(scope)) {
                        if (not CapabilityScope.equal(scope, reservation.app_scope)) {
                            resolved := #conflict;
                        };
                    };
                    case (#conflict) {};
                };
            };
        };
        resolved;
    };

    func activeCount(mem : Types.Memory) : Nat {
        var count = 0;
        for (reservation in Map.values(mem.reservations)) {
            if (not isInstallClaim(reservation)) count += 1;
        };
        count;
    };

    func activeAppCount(
        mem : Types.Memory,
        appScope : CapabilityTypes.AppScope,
    ) : Nat {
        var count = 0;
        for (reservation in Map.values(mem.reservations)) {
            if (
                not isInstallClaim(reservation) and
                CapabilityScope.equal(reservation.app_scope, appScope)
            ) count += 1;
        };
        count;
    };

    func activeReservationOwnership(
        mem : Types.Memory,
        scope : Types.ReservationScope,
    ) : ReservationOwnership {
        var resolved : ReservationOwnership = #none;
        for (reservation in Map.values(mem.reservations)) {
            if (
                not isInstallClaim(reservation) and
                scopeEqual(reservation.scope, scope)
            ) {
                switch (resolved) {
                    case (#none) {
                        resolved := #reservation(reservation);
                    };
                    case (#reservation(_)) resolved := #conflict;
                    case (#conflict) {};
                };
            };
        };
        resolved;
    };

    func scopeConflictCandidate(
        mem : Types.Memory,
        targetScope : CapabilityTypes.AppScope,
        scope : Types.ReservationScope,
    ) : ?Types.Reservation {
        var keeper : ?Types.Reservation = null;
        for (reservation in Map.values(mem.reservations)) {
            if (
                not isInstallClaim(reservation) and
                reservation.app_scope.app_id == targetScope.app_id and
                scopeEqual(reservation.scope, scope)
            ) {
                switch (keeper) {
                    case null keeper := ?reservation;
                    case (?current) {
                        let reservationExact = CapabilityScope.equal(
                            reservation.app_scope,
                            targetScope,
                        );
                        let currentExact = CapabilityScope.equal(
                            current.app_scope,
                            targetScope,
                        );
                        if (
                            (reservationExact and not currentExact) or
                            (reservationExact == currentExact and
                                reservation.id < current.id)
                        ) keeper := ?reservation;
                    };
                };
            };
        };
        var candidate : ?Types.Reservation = null;
        for (reservation in Map.values(mem.reservations)) {
            if (
                not isInstallClaim(reservation) and
                scopeEqual(reservation.scope, scope) and
                not sameReservationId(keeper, reservation.id)
            ) {
                candidate := lowerId(candidate, reservation);
            };
        };
        candidate;
    };

    func appCapacityCandidate(
        mem : Types.Memory,
        plan : Types.InstallReservationPlan,
    ) : ?Types.Reservation {
        var candidate : ?Types.Reservation = null;
        for (reservation in Map.values(mem.reservations)) {
            if (
                not isInstallClaim(reservation) and
                CapabilityScope.equal(
                    reservation.app_scope,
                    plan.app_scope,
                ) and
                not planContainsScope(plan, reservation.scope)
            ) {
                candidate := lowerId(candidate, reservation);
            };
        };
        candidate;
    };

    func globalCapacityCandidate(
        mem : Types.Memory,
        plans : [Types.InstallReservationPlan],
    ) : ?Types.Reservation {
        var candidate : ?Types.Reservation = null;
        for (reservation in Map.values(mem.reservations)) {
            if (
                not isInstallClaim(reservation) and
                not reservationRequiredByPlans(reservation, plans)
            ) {
                candidate := lowerId(candidate, reservation);
            };
        };
        candidate;
    };

    func reservationRequiredByPlans(
        reservation : Types.Reservation,
        plans : [Types.InstallReservationPlan],
    ) : Bool {
        for (plan in plans.vals()) {
            if (
                reservation.app_scope.app_id == plan.app_scope.app_id and
                planContainsScope(plan, reservation.scope)
            ) return true;
        };
        false;
    };

    func recoveryPlansFeasible(
        plans : [Types.InstallReservationPlan],
    ) : Bool {
        let appIds = Set.empty<Text>();
        let scopes = Set.empty<Text>();
        var total = 0;
        for (plan in plans.vals()) {
            if (
                plan.app_scope.installation_uid == 0 or
                not Set.insert(
                    appIds,
                    Text.compare,
                    plan.app_scope.app_id,
                ) or
                plan.reservations.size() > MAX_PER_APP
            ) return false;
            for (scope in plan.reservations.vals()) {
                total += 1;
                if (
                    total > MAX_TOTAL or
                    not Set.insert(
                        scopes,
                        Text.compare,
                        recoveryScopeKey(scope),
                    )
                ) return false;
            };
        };
        true;
    };

    func recoveryScopeKey(scope : Types.ReservationScope) : Text {
        switch (scope) {
            case (#exact(value)) {
                "exact:" # Principal.toText(value.principal) # ":" #
                value.method;
            };
            case (#principal(principal)) {
                "principal:" # Principal.toText(principal);
            };
            case (#method(method)) "method:" # method;
        };
    };

    func planContainsScope(
        plan : Types.InstallReservationPlan,
        scope : Types.ReservationScope,
    ) : Bool {
        for (desired in plan.reservations.vals()) {
            if (scopeEqual(desired, scope)) return true;
        };
        false;
    };

    func sameReservationId(
        reservation : ?Types.Reservation,
        id : Nat,
    ) : Bool {
        switch (reservation) {
            case (?value) value.id == id;
            case null false;
        };
    };

    func lowerId(
        current : ?Types.Reservation,
        candidate : Types.Reservation,
    ) : ?Types.Reservation {
        switch (current) {
            case null ?candidate;
            case (?value) {
                if (candidate.id < value.id) ?candidate else current;
            };
        };
    };

    func recoveryBlocker(
        reservation : Types.Reservation,
        reason : Types.PendingReservationBlockerReason,
    ) : Types.PendingReservationBlocker {
        {
            reservation = summary(reservation);
            reason;
        };
    };

    func installClaimForScope(
        mem : Types.Memory,
        scope : Types.ReservationScope,
    ) : ?Types.Reservation {
        for (reservation in Map.values(mem.reservations)) {
            if (
                isInstallClaim(reservation) and
                scopeEqual(reservation.scope, scope)
            ) return ?reservation;
        };
        null;
    };

    func installClaimForAppScope(
        mem : Types.Memory,
        appId : Text,
        scope : Types.ReservationScope,
    ) : ?Types.Reservation {
        for (reservation in Map.values(mem.reservations)) {
            if (
                isInstallClaim(reservation) and
                reservation.app_scope.app_id == appId and
                scopeEqual(reservation.scope, scope)
            ) return ?reservation;
        };
        null;
    };

    func installClaimsEqual(
        mem : Types.Memory,
        plans : [Types.InstallReservationPlan],
    ) : Bool {
        var expected = 0;
        for (plan in plans.vals()) {
            expected += plan.reservations.size();
            for (scope in plan.reservations.vals()) {
                var found = false;
                for (reservation in Map.values(mem.reservations)) {
                    if (
                        isInstallClaim(reservation) and
                        reservation.app_scope.app_id ==
                            plan.app_scope.app_id and
                        scopeEqual(reservation.scope, scope)
                    ) found := true;
                };
                if (not found) return false;
            };
        };
        var actual = 0;
        for (reservation in Map.values(mem.reservations)) {
            if (isInstallClaim(reservation)) actual += 1;
        };
        actual == expected;
    };

    func installClaimScope(appId : Text) : CapabilityTypes.AppScope {
        {
            app_id = appId;
            installation_uid = 0;
        };
    };

    func isInstallClaim(reservation : Types.Reservation) : Bool {
        reservation.app_scope.installation_uid == 0;
    };

    func copyMemory(target : Types.Memory, source : Types.Memory) : () {
        target.next_id := source.next_id;
        Map.clear(target.reservations);
        for ((id, reservation) in Map.entries(source.reservations)) {
            Map.add(target.reservations, Nat.compare, id, reservation);
        };
    };

    func removeWhere(mem : Types.Memory, predicate : Types.Reservation -> Bool) : () {
        let ids = List.empty<Nat>();
        for ((id, reservation) in Map.entries(mem.reservations)) {
            if (predicate(reservation)) List.add(ids, id);
        };
        for (id in List.values(ids)) Map.remove(mem.reservations, Nat.compare, id);
    };
};
