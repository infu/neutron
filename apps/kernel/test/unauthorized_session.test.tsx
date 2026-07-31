import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UnauthorizedSession } from "../src/UnauthorizedSession.tsx";

test("unauthorized session keeps identity controls in the centered screen", () => {
  const principal = "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe";
  const html = renderToStaticMarkup(
    <UnauthorizedSession
      authError="This principal needs authorization."
      onLogout={() => undefined}
      principal={principal}
    />,
  );

  expect(html).toContain('data-tid="auth-error"');
  expect(html).toContain('data-tid="principal"');
  expect(html).toContain(principal);
  expect(html).toContain('aria-label="Copy current principal"');
  expect(html).toContain('data-tid="logout-button"');
  expect(html).not.toContain("auth-menu-toggle");
  expect(html).not.toContain("Account menu");
});
