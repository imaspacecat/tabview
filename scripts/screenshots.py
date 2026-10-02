"""Capture README screenshots with synthetic tabs in a disposable Firefox profile.

Build first, then run with Selenium, geckodriver, and Firefox available.
"""
import json
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import shutil
import tempfile
import threading
from urllib.parse import urlsplit
import zipfile

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import Select, WebDriverWait


root = Path(__file__).resolve().parent.parent
destination = root / 'docs' / 'screenshots'
destination.mkdir(parents=True, exist_ok=True)
binary = os.environ.get('TABVIEW_BROWSER') or shutil.which('firefox')
if not binary:
    raise SystemExit('Firefox was not found. Set TABVIEW_BROWSER to its executable.')

fixtures = {
    'docs.example.com': ['Getting started with TypeScript', 'CSS grid layout guide', 'Firefox extension APIs', 'Accessible keyboard navigation', 'DOM event reference', 'Web performance checklist'],
    'code.example.com': ['Tabview — project overview', 'Review: improve tab recovery', 'Issue: keyboard shortcuts', 'Release notes — October', 'Build workflow reference', 'Contributing to Tabview'],
    'research.example.com': ['A study of browser tab habits', 'Designing for keyboard users', 'Information retrieval notes', 'Search ranking experiments'],
    'design.example.com': ['Dashboard layout sketches', 'Compact card examples', 'Icon design reference', 'Typography for interfaces'],
    'news.example.com': ['Firefox updates this month', 'The open web newsletter', 'New tools for developers', 'Community project highlights'],
    'notes.example.com': ['Weekend reading list', 'Ideas for the next release', 'Project planning notes', 'Things to learn this autumn'],
}

colors = dict(zip(fixtures, ['#2563eb', '#7c3aed', '#059669', '#db2777', '#ea580c', '#0891b2']))


class FixturePage(BaseHTTPRequestHandler):
    def do_GET(self):
        domain = self.headers['Host'].split(':')[0]
        path = urlsplit(self.path).path
        if domain not in fixtures:
            self.send_error(404)
            return
        if path == '/favicon.svg':
            label = domain[0].upper()
            body = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="{colors[domain]}"/><text x="16" y="23" text-anchor="middle" font-family="sans-serif" font-size="23" font-weight="bold" fill="white">{label}</text></svg>'
            content_type = 'image/svg+xml'
        else:
            index = int(path.rsplit('/', 1)[-1]) - 1
            title = escape(fixtures[domain][index])
            body = f'<html><head><title>{title}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"></head><body><h1>{title}</h1><p>Local screenshot fixture.</p></body></html>'
            content_type = 'text/html; charset=utf-8'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *args):
        pass


with tempfile.TemporaryDirectory(prefix='tabview-screenshots-') as temporary:
    addon = Path(temporary) / 'tabview.xpi'
    with zipfile.ZipFile(addon, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in sorted((root / 'dist').rglob('*')):
            if path.is_file():
                archive.write(path, path.relative_to(root / 'dist'))
    options = webdriver.FirefoxOptions()
    options.binary_location = binary
    options.add_argument('-headless')
    options.add_argument('--remote-allow-system-access')
    options.set_preference('browser.shell.checkDefaultBrowser', False)
    options.set_preference('browser.newtabpage.enabled', False)
    options.set_preference('network.dns.localDomains', ','.join(fixtures))
    options.set_preference('network.proxy.type', 0)
    options.set_preference('dom.security.https_only_mode', False)
    options.set_preference('dom.security.https_first', False)
    server = ThreadingHTTPServer(('127.0.0.1', 0), FixturePage)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with webdriver.Firefox(options=options) as driver:
            driver.set_window_size(1280, 800)
            driver.install_addon(str(addon), temporary=True)
            driver.set_context('chrome')
            extension_id = json.loads((root / 'public' / 'manifest.json').read_text())['browser_specific_settings']['gecko']['id']
            uuid = driver.execute_script("return JSON.parse(Services.prefs.getStringPref('extensions.webextensions.uuids'))[arguments[0]];", extension_id)
            driver.set_context('content')
            driver.get(f'moz-extension://{uuid}/index.html')
            wait = WebDriverWait(driver, 30)
            wait.until(lambda browser: ' of ' in browser.find_element(By.ID, 'count').text)
            tabs = [{'url': f'http://{domain}:{server.server_port}/articles/{index + 1}'} for domain, titles in fixtures.items() for index, title in enumerate(titles)]
            result = driver.execute_async_script("""
                const done = arguments[arguments.length - 1];
                (async () => {
                    const existing = await browser.tabs.query({});
                    for (const tab of existing) if (!tab.url.startsWith(location.origin)) await browser.tabs.remove(tab.id);
                    for (const tab of arguments[0]) await browser.tabs.create({...tab, active: false});
                    done(true);
                })().catch(error => done(String(error)));
            """, tabs)
            assert result is True, result
            wait.until(lambda browser: browser.execute_async_script("""
                const done = arguments[arguments.length - 1];
                browser.tabs.query({}).then(tabs => done(tabs.filter(tab => !tab.url.startsWith(location.origin)).every(tab => tab.status === 'complete' && (tab.favIconUrl?.endsWith('/favicon.svg') || tab.favIconUrl?.startsWith('data:image/svg+xml')))));
            """))
            wait.until(lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.tab-row')) == len(tabs))

            def capture(name, height):
                driver.set_window_size(1280, height)
                driver.execute_script('document.activeElement.blur(); window.scrollTo(0, 0);')
                driver.execute_async_script('document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(arguments[0])));')
                wait.until(lambda browser: browser.execute_script("""
                    const icons = [...document.querySelectorAll('.tab-icon')];
                    return icons.length > 0 && icons.every(icon => (icon.src.endsWith('/favicon.svg') || icon.src.startsWith('data:image/svg+xml')) && icon.complete && icon.naturalWidth > 0);
                """))
                driver.save_screenshot(str(destination / name))

            capture('dashboard.png', 800)
            Select(driver.find_element(By.ID, 'group')).select_by_value('domain')
            wait.until(lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.domain-card')) == len(fixtures))
            capture('domains.png', 500)
            Select(driver.find_element(By.ID, 'group')).select_by_value('none')
            driver.find_element(By.ID, 'search').send_keys('keyboard')
            wait.until(lambda browser: browser.find_elements(By.CSS_SELECTOR, 'mark'))
            driver.find_element(By.ID, 'select-all').click()
            wait.until(lambda browser: browser.find_element(By.ID, 'bulk').is_displayed())
            capture('search-selection.png', 550)
            print(f'Saved three screenshots to {destination}')
    finally:
        server.shutdown()
        server.server_close()
