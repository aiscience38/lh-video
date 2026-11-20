import { test, expect } from "./fixtures";
import en from "../../src/messages/en.json";
import es from "../../src/messages/es.json";

const messages = { en, es } as const;

for (const [locale, dictionary] of Object.entries(messages)) {
    test(`${locale}: Library appears between Studio and Providers and opens the overview`, async ({ page }) => {
        await page.goto(`/${locale}`);
        const navigation = page.getByRole("navigation", { name: dictionary.workspace.navigation });
        await expect(navigation.getByRole("link")).toHaveText([
            dictionary.workspace.studio,
            dictionary.workspace.library,
            dictionary.workspace.providers,
        ]);
        const library = navigation.getByRole("link", { name: dictionary.workspace.library, exact: true });
        await expect(library).toBeVisible();
        await expect(library).toHaveAttribute("href", `/${locale}/library`);
        await library.click();
        await expect(page.getByRole("heading", { name: dictionary.library.overview.title })).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`/${locale}/library$`));
    });
}

test.describe("mobile", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("Library navigation stays visible at narrow widths", async ({ page }) => {
        await page.goto("/en");
        const library = page.getByRole("navigation", { name: en.workspace.navigation })
            .getByRole("link", { name: en.workspace.library, exact: true });
        await expect(library).toBeVisible();
        await expect(library.locator("svg")).toBeVisible();
    });
});
