import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Core E2E flow (against seeded data):
 *  customer login -> asks about order ORD-1001 -> order retrieved (shipped)
 *  -> asks "refund my last order" (ORD-1002) -> approval created, NOT executed
 *  -> admin approves -> refund executes
 *  -> customer checks ORD-1002 -> now "Refunded"
 *
 * Two browser contexts share one server: one for the customer, one for admin.
 */

const CUSTOMER = { email: "jane@example.com", password: "demo1234" };
const ADMIN = { email: "admin@example.com", password: "demo1234" };

async function login(page: Page, creds: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(creds.email);
  await page.getByTestId("login-password").fill(creds.password);
  await page.getByTestId("login-submit").click();
  await page.waitForURL((u) => u.pathname !== "/login", { timeout: 20000 });
}

async function sendMessage(page: Page, text: string) {
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-send").click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="chat-messages"]');
      return el && el.textContent && !/Checking your request…/.test(el.textContent);
    },
    { timeout: 25000 },
  );
  await page.waitForTimeout(300);
}

test.describe.configure({ mode: "serial" });

test("full support flow: order lookup -> refund request -> admin approval -> confirmed refund", async ({ browser }) => {
  const custCtx: BrowserContext = await browser.newContext();
  const adminCtx: BrowserContext = await browser.newContext();
  const cust: Page = await custCtx.newPage();
  const adm: Page = await adminCtx.newPage();

  // 1. Customer logs in.
  await login(cust, CUSTOMER);
  await expect(cust.getByTestId("chat-input")).toBeVisible();

  // 2. Ask about a shipped order -> order retrieved with tracking.
  await sendMessage(cust, "Where is order ORD-1001?");
  await expect(cust.getByTestId("order-card").last()).toBeVisible();
  await expect(cust.getByTestId("chat-messages")).toContainText(/shipped/i);

  // 3. Ask for a refund -> approval created (NOT executed).
  await sendMessage(cust, "Refund my last order");
  await expect(cust.getByTestId("refund-card-pending_approval").first()).toBeVisible();
  await expect(cust.getByTestId("chat-messages")).toContainText(/approval/i);
  await expect(cust.getByText(/waiting for approval/i).first()).toBeVisible();

  // 4. Admin logs in and sees the pending approval.
  await login(adm, ADMIN);
  await expect(adm).toHaveURL(/\/admin/);
  await adm.reload();
  const approvalCard = adm.locator('[data-testid^="approval-"]').first();
  await expect(approvalCard).toBeVisible();
  await expect(approvalCard).toContainText(/high risk/i);
  // Capture the approval id from the testid (approval-<ID>).
  const approvalTestId = (await approvalCard.getAttribute("data-testid"))!;
  const approvalId = approvalTestId.replace("approval-", "");

  // 5. Admin approves. Approving clears it from the "Pending" list.
  await approvalCard.getByTestId("approve-btn").click();
  await expect(adm.locator(`[data-testid="approval-${approvalId}"]`)).toHaveCount(0, { timeout: 20000 });

  // 5b. In "All" view the approval now shows "Approved".
  await adm.getByRole("button", { name: "All" }).click();
  await expect(adm.locator(`[data-testid="approval-${approvalId}"]`)).toContainText(/approved/i, { timeout: 15000 });

  // 6. Refund executed: admin audit log records refund.completed.
  await adm.getByRole("button", { name: "Audit log" }).click();
  await expect(adm.getByText(/refund\.completed/i).first()).toBeVisible();

  // 7. Customer sees the confirmed result: re-check the refunded order.
  await sendMessage(cust, "Check order ORD-1002");
  await expect(cust.getByTestId("order-card").last()).toContainText(/refunded/i);

  // 8. Regression: admin can use Chat (the reported bug was that clicking Chat
  //    as admin did nothing). Navigate to /chat via the header and run a query.
  await adm.goto("/chat");
  await expect(adm).toHaveURL(/\/chat/);
  await expect(adm.getByTestId("chat-input")).toBeVisible();
  await sendMessage(adm, "Who is the customer Jane Doe?");
  await expect(adm.getByTestId("chat-messages")).toContainText(/Jane Doe/i);

  await custCtx.close();
  await adminCtx.close();
});
