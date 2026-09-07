import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Support dashboard E2E (against seeded data).
 *  - support agent logs in -> lands on /support, sees seeded ticket TCK-1001
 *  - selects it -> detail shows subject, customer, linked order
 *  - changes status + adds an internal note -> both persist and re-render
 *  - customers are redirected away from /support
 */

const SUPPORT = { email: "riley@support.example.com", password: "demo1234" };
const CUSTOMER = { email: "jane@example.com", password: "demo1234" };

async function login(page: Page, creds: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(creds.email);
  await page.getByTestId("login-password").fill(creds.password);
  await page.getByTestId("login-submit").click();
  await page.waitForURL((u) => u.pathname !== "/login", { timeout: 20000 });
}

test.describe.configure({ mode: "serial" });

test("support agent can open a ticket, act on it, and customers are locked out", async ({ browser }) => {
  const ctx: BrowserContext = await browser.newContext();
  const page = await ctx.newPage();

  // 1. Support agent lands on the dashboard.
  await login(page, SUPPORT);
  await expect(page).toHaveURL(/\/support/);
  await expect(page.getByTestId("support-tickets-list")).toBeVisible();

  // 2. The seeded ticket is listed.
  const card = page.getByTestId("support-ticket-card-TCK-1001");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("support-ticket-subject")).toContainText(/Return label/i);

  // 3. Select it -> detail pane shows subject, customer and the linked order.
  await card.click();
  const detail = page.getByTestId("support-detail");
  await expect(detail).toContainText(/Return label/i);
  await expect(detail.getByTestId("support-customer")).toContainText(/Jane/i);
  await expect(detail.getByTestId("support-order")).toContainText(/ORD-1003/);
  await expect(detail.getByTestId("support-description")).toBeVisible();

  // 4. Change status to resolved -> the pill re-renders with "Resolved".
  await detail.getByTestId("support-status-select").selectOption("resolved");
  await expect(detail.getByTestId("support-detail-status")).toHaveText("Resolved");

  // 5. Add an internal note -> it appears in the agent-only thread.
  await detail.getByTestId("support-note-input").fill("Contacted the customer to confirm the return window.");
  await detail.getByTestId("support-note-add").click();
  await expect(detail.getByTestId("support-note-0")).toContainText(/Contacted the customer/i);

  // 6. The list reflects the updated status after the action.
  await expect(page.getByTestId("support-list-status-TCK-1001")).toHaveText("Resolved");

  await ctx.close();

  // 7. A customer cannot use the dashboard: redirected to /chat.
  const custCtx: BrowserContext = await browser.newContext();
  const cust = await custCtx.newPage();
  await login(cust, CUSTOMER);
  await cust.goto("/support");
  await expect(cust).toHaveURL(/\/chat/, { timeout: 20000 });
  await custCtx.close();
});
