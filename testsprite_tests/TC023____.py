import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

async def run_test():
    pw = None
    browser = None
    context = None

    try:
        # Start a Playwright session in asynchronous mode
        pw = await async_api.async_playwright().start()

        # Launch a Chromium browser in headless mode with custom arguments
        browser = await pw.chromium.launch(
            headless=True,
            args=[
                "--window-size=1280,720",
                "--disable-dev-shm-usage",
                "--ipc=host",
                "--single-process"
            ],
        )

        # Create a new browser context (like an incognito window)
        context = await browser.new_context()
        # Wider default timeout to match the agent's DOM-stability budget;
        # auto-waiting Playwright APIs (expect, locator.wait_for) inherit this.
        context.set_default_timeout(15000)

        # Open a new page in the browser context
        page = await context.new_page()

        # Interact with the page elements to simulate user flow
        # -> navigate
        await page.goto("http://localhost:3000")
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        
        # -> املأ حقل البريد الإلكتروني بـ "example@gmail.com" وحقّل كلمة المرور بـ "password123" ثم انقر زر "تسجيل الدخول".
        # example@email.com email field
        elem = page.get_by_placeholder('example@email.com', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("example@gmail.com")
        
        # -> املأ حقل البريد الإلكتروني بـ "example@gmail.com" وحقّل كلمة المرور بـ "password123" ثم انقر زر "تسجيل الدخول".
        # •••••••• password field
        elem = page.get_by_placeholder('••••••••', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("password123")
        
        # -> املأ حقل البريد الإلكتروني بـ "example@gmail.com" وحقّل كلمة المرور بـ "password123" ثم انقر زر "تسجيل الدخول".
        # تسجيل الدخول button
        elem = page.locator('[id="btn_submit_login"]')
        await elem.click(timeout=10000)
        
        # -> انقر على زر الشريط الجانبي المسمى 'النسخ الاحتياطي والاستعادة' لفتح صفحة النسخ الاحتياطي.
        # النسخ الاحتياطي والاستعادة button
        elem = page.get_by_role('button', name='النسخ الاحتياطي والاستعادة', exact=True)
        await elem.click(timeout=10000)
        
        # -> انقر على زر 'حفظ وتثبيت نسخة احتياطية محلياً عيني 📥' لبدء تصدير النسخة الاحتياطية المحلية.
        # Download: حفظ وتثبيت نسخة احتياطية محلياً عيني 📥 button
        elem = page.locator('[id="export_local_json_backup_btn"]')
        async with page.expect_download(timeout=30000) as dl_info:
            await elem.click(timeout=10000)
        download = await dl_info.value
        assert download.suggested_filename  # verify file was downloaded
        await download.save_as(f"./downloads/{download.suggested_filename}")
        
        # -> انقر زر "حفظ وتثبيت نسخة احتياطية محلياً عيني 📥" لبدء تصدير النسخة الاحتياطية محليًا ثم تحقق من ظهور رسالة نجاح أو رابط/عنصر تنزيل.
        # Download: حفظ وتثبيت نسخة احتياطية محلياً عيني 📥 button
        elem = page.locator('[id="export_local_json_backup_btn"]')
        async with page.expect_download(timeout=30000) as dl_info:
            await elem.click(timeout=10000)
        download = await dl_info.value
        assert download.suggested_filename  # verify file was downloaded
        await download.save_as(f"./downloads/{download.suggested_filename}")
        
        # --> Assertions to verify final state
        
        # --> Verify a backup export is available
        await page.locator("xpath=/html/body/div[1]/div/div/div/div/main/div/div/div[3]/div[2]/div[1]/button").nth(0).scroll_into_view_if_needed()
        # Assert: The local backup export button 'حفظ وتثبيت نسخة احتياطية محلياً عيني 📥' is visible.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div/main/div/div/div[3]/div[2]/div[1]/button").nth(0)).to_be_visible(timeout=15000), "The local backup export button '\u062d\u0641\u0638 \u0648\u062a\u062b\u0628\u064a\u062a \u0646\u0633\u062e\u0629 \u0627\u062d\u062a\u064a\u0627\u0637\u064a\u0629 \u0645\u062d\u0644\u064a\u0627\u064b \u0639\u064a\u0646\u064a \ud83d\udce5' is visible."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    