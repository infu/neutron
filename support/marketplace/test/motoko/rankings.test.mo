import Rankings "../../mo/Rankings";
import Test "mo:test";

persistent actor {
  public query func exact_windows() : async Test.Metrics {
    Test.test(func () {
      let now : Int = 10_000_000_000_000_000;
      assert Rankings.inWindow(now, now, #week);
      assert not Rankings.inWindow(now + 1, now, #week);
      assert not Rankings.inWindow(now - Rankings.weekNs, now, #week);
      assert Rankings.inWindow(now - Rankings.weekNs + 1, now, #week);
      assert not Rankings.inWindow(now - Rankings.monthNs, now, #month);
      assert Rankings.inWindow(now - Rankings.monthNs + 1, now, #month);
      assert Rankings.inWindow(0, now, #all);
    });
  };

  public query func free_and_paid_history_stays_separate() : async Test.Metrics {
    Test.test(func () {
      let free = Rankings.add(Rankings.emptyCounters(), #free);
      let both = Rankings.add(free, #paid);
      assert both.free7 == 1 and both.paid7 == 1;
      let weeklyExpired = Rankings.expire(both, #free, #week);
      assert weeklyExpired.free7 == 0 and weeklyExpired.free30 == 1 and weeklyExpired.freeAll == 1;
      assert weeklyExpired.paid7 == 1 and weeklyExpired.paid30 == 1 and weeklyExpired.paidAll == 1;
      let monthlyExpired = Rankings.expire(weeklyExpired, #free, #month);
      assert monthlyExpired.free30 == 0 and monthlyExpired.freeAll == 1;
      assert Rankings.score(monthlyExpired, #paid, #all) == 1;
    });
  };
}
