import Audits "../../mo/Audits";
import Publishing "../../mo/Publishing";
import Test "mo:test";

persistent actor {
  public query func boundaries() : async Test.Metrics {
    Test.test(func () {
      assert not Publishing.validReleaseVersion(99);
      assert Publishing.validReleaseVersion(100);
      assert Publishing.validReleaseVersion(9_007_199_254_740_991);
      assert not Publishing.validReleaseVersion(9_007_199_254_740_992);
      assert Audits.validateStamp("request", #approved, "Inspected exact package and source", "") == #ok(());
      assert Audits.validateStamp("", #approved, "Inspected exact package", "") != #ok(());
      assert Audits.validateStamp("request", #approved, " \n ", "") != #ok(());
      assert Audits.validateStamp("request", #rejected, "Inspected exact package", " \n ") != #ok(());
      assert Audits.validateStamp("request", #rejected, "Inspected exact package", "Unexpected external credential transfer") == #ok(());
      assert Audits.validateStamp("request", #revoked, "Reviewed new evidence", "") != #ok(());
      assert Audits.validateStamp("request", #revoked, "Reviewed new evidence", "Published package fails its stated behavior") == #ok(());
    });
  };
}
