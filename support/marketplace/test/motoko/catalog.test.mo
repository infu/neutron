import Catalog "../../mo/Catalog";
import Test "mo:test";

persistent actor {
  public query func boundaries() : async Test.Metrics {
    Test.test(func () {
      assert Catalog.validPrice(0);
      assert not Catalog.validPrice(1);
      assert not Catalog.validPrice(999_999);
      assert Catalog.validPrice(1_000_000);
      assert Catalog.validPrice(1_000_001);
      assert Catalog.validPrice(50_000_000);
      assert not Catalog.validPrice(50_000_001);

      assert Catalog.validAppId("aave");
      assert Catalog.validAppId("sns_governance");
      assert Catalog.validAppId("app0");
      assert not Catalog.validAppId("abc");
      assert not Catalog.validAppId("_aave");
      assert not Catalog.validAppId("aave_");
      assert not Catalog.validAppId("sns__governance");
      assert not Catalog.validAppId("Aave");
      assert not Catalog.validAppId("aave-swap");
      assert not Catalog.validAppId("aave/../../kernel");
      assert not Catalog.validAppId("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

      assert Catalog.hasText(" Name ");
      assert not Catalog.hasText(" \t\n\r ");
      assert Catalog.validateListing("aave", "Aave", "Lending client", 1_000_000) == #ok(());
      assert Catalog.validateListing("aave", "Aave", "Lending client", 900_000) != #ok(());
    });
  };
}
