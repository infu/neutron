import InstallLimits "../install/Limits";

module {
    public let MAX_RESIDENT_FRAMES : Nat = 32;

    public type SurfaceCounts = {
        app_instances : Nat;
        resident_frames : Nat;
    };

    /**
     * Defense-in-depth validation for the compiler-derived frontend surface
     * inventory. The compiler and browser reject the same target before
     * activation; the assembled actor also retains this closed check.
     */
    public func accepts(counts : SurfaceCounts) : Bool {
        counts.app_instances >= 1 and
        counts.app_instances <= InstallLimits.MAX_APP_INSTANCES and
        counts.resident_frames <= counts.app_instances and
        counts.resident_frames <= MAX_RESIDENT_FRAMES;
    };
};
