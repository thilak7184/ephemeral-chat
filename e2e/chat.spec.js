import { expect, test } from '@playwright/test';

test('two browsers exchange a message and leaving releases the seat', async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();

  await ownerPage.goto('/');
  await ownerPage.getByRole('button', { name: 'Create a room' }).click();
  await expect(ownerPage).toHaveURL(/\/r\/[A-HJ-NP-Z2-9]{6}#/);

  await guestPage.goto(ownerPage.url());
  await expect(ownerPage.getByText('2 / 2 here')).toBeVisible();
  await expect(guestPage.getByText('2 / 2 here')).toBeVisible();

  const message = `browser flow ${Date.now()}`;
  await ownerPage.locator('#chat-message').fill(message);
  await ownerPage.getByRole('button', { name: 'Send message' }).click();
  await expect(guestPage.getByText(message, { exact: true })).toBeVisible();

  await guestPage.getByRole('link', { name: 'Ephemeral home' }).click();
  await expect(guestPage).toHaveURL('/');
  await expect(ownerPage.getByText('Someone left the room.')).toBeVisible();

  await ownerContext.close();
  await guestContext.close();
});
