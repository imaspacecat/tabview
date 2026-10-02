import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import zipfile

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support.ui import WebDriverWait, Select
from selenium.webdriver.firefox.service import Service


def browser_selected(driver):
    return bool(driver.find_elements(By.CSS_SELECTOR, 'input[data-tab-id]:checked'))


root = Path(__file__).resolve().parent.parent
(root / 'artifacts').mkdir(exist_ok=True)
options = webdriver.FirefoxOptions()
browser_binary = os.environ.get('TABVIEW_BROWSER') or shutil.which('firefox')
if not browser_binary:
    raise SystemExit('Firefox was not found. Set TABVIEW_BROWSER to your Firefox or Zen executable.')
options.binary_location = browser_binary
options.add_argument('-headless')
options.add_argument('--remote-allow-system-access')
options.set_preference('browser.sessionstore.resume_from_crash', False)
options.set_preference('browser.shell.checkDefaultBrowser', False)
options.set_preference('browser.newtabpage.enabled', False)
options.set_preference('browser.startup.page', 0)
options.set_preference('privacy.userContext.enabled', True)


class IconPage(BaseHTTPRequestHandler):
    def do_GET(self):
        image = self.path == '/icon.svg'
        self.send_response(200)
        self.send_header('Content-Type', 'image/svg+xml' if image else 'text/html')
        self.end_headers()
        self.wfile.write(b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="green"/></svg>' if image else b'<html><head><title>Tabview icon fixture</title><link rel="icon" href="/icon.svg"></head><body>Local icon fixture</body></html>')

    def log_message(self, *args):
        pass

with tempfile.TemporaryDirectory(prefix='tabview-smoke-') as temporary:
    xpi = Path(temporary) / 'tabview.xpi'
    with zipfile.ZipFile(xpi, 'w', zipfile.ZIP_DEFLATED) as archive:
        for file in (root / 'dist').rglob('*'):
            if file.is_file():
                archive.write(file, file.relative_to(root / 'dist'))
    process = None
    if 'zen' in Path(options.binary_location).name.lower():
        profile = Path(temporary) / 'profile'
        profile.mkdir()
        with socket.socket() as available:
            available.bind(('127.0.0.1', 0))
            port = available.getsockname()[1]
        preferences = dict(options.preferences)
        preferences['marionette.port'] = port
        (profile / 'user.js').write_text('\n'.join(f'user_pref({json.dumps(key)}, {json.dumps(value)});' for key, value in preferences.items()))
        process = subprocess.Popen([options.binary_location, '-headless', '--remote-allow-system-access', '-no-remote', '-profile', str(profile), '-marionette'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=.1):
                    break
            except OSError:
                time.sleep(.1)
        service = Service(executable_path=shutil.which('geckodriver'), service_args=['--connect-existing', '--marionette-port', str(port)])
        try:
            driver = webdriver.Firefox(service=service, options=webdriver.FirefoxOptions())
        except BaseException:
            process.terminate()
            process.wait(timeout=10)
            raise
    else:
        driver = webdriver.Firefox(options=options)
    driver.set_script_timeout(180)
    driver.set_window_size(1200, 850)
    wait = WebDriverWait(driver, 30)
    icon_server = ThreadingHTTPServer(('127.0.0.1', 0), IconPage)
    threading.Thread(target=icon_server.serve_forever, daemon=True).start()
    try:
        driver.install_addon(str(xpi), temporary=True)
        driver.set_context('chrome')
        uuid = driver.execute_script("return JSON.parse(Services.prefs.getStringPref('extensions.webextensions.uuids'))['tabview@spacecat.local'];")
        driver.set_context('content')
        driver.get(f'moz-extension://{uuid}/index.html')
        wait.until(lambda browser: ' of ' in browser.find_element(By.ID, 'count').text)

        def rpc(message):
            reply = driver.execute_async_script("const done = arguments[arguments.length - 1]; browser.runtime.sendMessage(arguments[0]).then(done, e => done({ok:false,error:String(e)}));", message)
            assert reply['ok'], reply
            return reply.get('value')
        driver.execute_async_script("const done = arguments[arguments.length - 1]; Promise.all(Array.from({length:8}, (_,i) => browser.tabs.create({url:'https://example.com/tabview-smoke-'+i,title:'Tabview smoke '+i,discarded:true,active:false}))).then(done, e => done(String(e)));")
        wait.until(lambda browser: len(rpc({'type': 'snapshot'})['tabs']) >= 8)
        snapshot = rpc({'type': 'snapshot'})
        seeded = [tab for tab in snapshot['tabs'] if 'tabview-smoke-' in tab['url']]
        assert len(seeded) == 8
        assert all(tab.get('openedAt') for tab in seeded), 'creation timestamps missing'
        fixture_url = f'http://127.0.0.1:{icon_server.server_port}/'
        driver.execute_async_script("const done=arguments[arguments.length-1];browser.tabs.create({url:arguments[0],active:false}).then(done);", fixture_url)
        wait.until(lambda browser: any(tab['url'] == fixture_url and tab.get('favIconUrl') for tab in rpc({'type': 'snapshot'})['tabs']))
        fixture_icon = next(tab['favIconUrl'] for tab in rpc({'type': 'snapshot'})['tabs'] if tab['url'] == fixture_url)
        dashboard = driver.current_window_handle
        search = driver.find_element(By.ID, 'search')
        search.send_keys('tabview smoke')
        wait.until(lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.tab-row')) == 8)
        assert driver.find_elements(By.CSS_SELECTOR, 'mark')
        wait.until(lambda browser: browser.execute_script("return [...document.querySelectorAll('.tab-icon')].every(image=>image.complete && image.naturalWidth>0);"))
        driver.set_window_size(600, 850)
        assert driver.execute_script("return [...document.querySelectorAll('.tab-row .badges')].every(badge=>getComputedStyle(badge).display!=='none'&&badge.getBoundingClientRect().width>0);")
        driver.set_window_size(1200, 850)
        rows = driver.find_elements(By.CSS_SELECTOR, '.tab-row')
        assert rows[0].rect['y'] == rows[1].rect['y'], 'grid must show multiple tabs per row'
        columns = sum(row.rect['y'] == rows[0].rect['y'] for row in rows)
        assert rows[columns].rect['y'] > rows[0].rect['y'], 'grid must span multiple rows'
        assert rows[0].rect['height'] <= 48, 'grid cards should be compact'
        expected = {int(rows[index].get_attribute('data-id')) for index in [0, 1, columns, columns + 1]}
        first_rect, last_rect = rows[0].rect, rows[columns + 1].rect
        actions = ActionChains(driver)
        pointer = actions.w3c_actions.pointer_action
        pointer.move_to_location(int(first_rect['x'] + 60), int(first_rect['y'] + 8))
        pointer.pointer_down()
        pointer.move_to_location(int(last_rect['x'] + last_rect['width'] - 10), int(last_rect['y'] + last_rect['height'] - 8))
        pointer.pointer_up()
        actions.perform()
        checked = {int(element.get_attribute('data-tab-id')) for element in driver.find_elements(By.CSS_SELECTOR, 'input[data-tab-id]:checked')}
        assert checked == expected, (checked, expected)
        assert driver.current_url == f'moz-extension://{uuid}/index.html', 'drag must not activate a tab'
        extra = next(row for row in rows if int(row.get_attribute('data-id')) not in expected)
        rect = extra.rect
        actions = ActionChains(driver)
        pointer = actions.w3c_actions.pointer_action
        pointer.move_to_location(int(rect['x'] + 60), int(rect['y'] + 8))
        pointer.pointer_down()
        pointer.move_to_location(int(rect['x'] + rect['width'] - 10), int(rect['y'] + rect['height'] - 8))
        pointer.pointer_up()
        actions.perform()
        checked = {int(element.get_attribute('data-tab-id')) for element in driver.find_elements(By.CSS_SELECTOR, 'input[data-tab-id]:checked')}
        assert checked == expected | {int(extra.get_attribute('data-id'))}, 'drags must add without modifiers'
        driver.find_element(By.ID, 'results').send_keys(Keys.ESCAPE)
        assert not driver.find_element(By.ID, 'bulk').is_displayed(), 'Escape must deselect'
        assert search.get_attribute('value') == 'tabview smoke', 'Escape must preserve search'
        driver.execute_async_script("const done=arguments[arguments.length-1];browser.tabs.create({url:'https://example.com/keyboard-close-fixture',title:'Keyboard close fixture',discarded:true,active:false}).then(done);")
        search.clear()
        search.send_keys('keyboard close fixture')
        wait.until(lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.tab-row')) == 1)
        driver.find_element(By.ID, 'select-all').click()
        search.send_keys(Keys.BACKSPACE)
        assert any('keyboard-close-fixture' in tab['url'] for tab in rpc({'type':'snapshot'})['tabs'])
        driver.find_element(By.ID, 'select-all').click()
        driver.find_element(By.CSS_SELECTOR, '.tab-open').send_keys(Keys.BACKSPACE)
        wait.until(lambda browser: '1 closed' in browser.find_element(By.ID, 'status').text)
        assert not any('keyboard-close-fixture' in tab['url'] for tab in rpc({'type':'snapshot'})['tabs'])
        assert not driver.find_element(By.ID, 'close-dialog').get_attribute('open')
        driver.find_element(By.ID, 'settings-open').click()
        wait.until(lambda browser: browser.find_element(By.ID, 'shortcut').get_attribute('value'))
        shortcut = driver.find_element(By.ID, 'shortcut')
        assert shortcut.get_attribute('value') == 'Ctrl+Alt+Y', 'default launch shortcut must match the manifest'
        shortcut.clear()
        shortcut.send_keys('Ctrl+Shift+U')
        driver.find_element(By.ID, 'shortcut-update').click()
        wait.until(lambda browser: 'updated' in browser.find_element(By.ID, 'shortcut-status').text)
        assert driver.execute_async_script("const done=arguments[arguments.length-1];browser.commands.getAll().then(commands=>done(commands.find(c=>c.name==='open-dashboard').shortcut));") == 'Ctrl+Shift+U'
        driver.find_element(By.ID, 'memory-diagnostics').click()
        assert driver.execute_script("const a=document.querySelector('#memory-address');return a.value==='about:processes'&&a.selectionStart===0&&a.selectionEnd===a.value.length;")
        driver.find_element(By.CSS_SELECTOR, '.keyboard-settings summary').click()
        for action, binding in [('closeSelected', 'Delete'), ('clearSelection', 'Ctrl+K')]:
            field = driver.find_element(By.CSS_SELECTOR, f'input[data-action="{action}"]')
            field.clear()
            field.send_keys(binding)
        driver.find_element(By.ID, 'save-settings').click()
        wait.until(lambda browser: not browser.find_element(By.ID, 'settings-dialog').get_attribute('open'))
        assert rpc({'type':'snapshot'})['preferences']['keybindings']['closeSelected'] == 'Delete'
        driver.execute_async_script("const done=arguments[arguments.length-1];browser.tabs.create({url:'https://example.com/remapped-close-fixture',title:'Remapped close fixture',discarded:true,active:false}).then(done);")
        search.clear()
        search.send_keys('remapped close fixture')
        wait.until(lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.tab-row')) == 1)
        driver.find_element(By.ID, 'select-all').click()
        driver.find_element(By.ID, 'results').send_keys(Keys.ESCAPE)
        assert browser_selected(driver), 'Old Escape binding must be disabled'
        driver.find_element(By.ID, 'results').send_keys(Keys.CONTROL, 'k')
        assert not driver.find_element(By.ID, 'bulk').is_displayed(), 'Custom deselection must work'
        driver.find_element(By.ID, 'select-all').click()
        driver.find_element(By.CSS_SELECTOR, '.tab-open').send_keys(Keys.BACKSPACE)
        assert any('remapped-close-fixture' in tab['url'] for tab in rpc({'type':'snapshot'})['tabs'])
        driver.find_element(By.CSS_SELECTOR, '.tab-open').send_keys(Keys.DELETE)
        wait.until(lambda browser: not any('remapped-close-fixture' in tab['url'] for tab in rpc({'type':'snapshot'})['tabs']))
        search.clear()
        search.send_keys('icon fixture')
        wait.until(lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.tab-row')) == 1)
        wait.until(lambda browser: browser.execute_script("const image=document.querySelector('.tab-icon');return image.src===arguments[0]&&image.complete&&image.naturalWidth>0;", fixture_icon))
        Select(driver.find_element(By.ID, 'group')).select_by_value('domain')
        wait.until(lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.domain-card')) == 1)
        wait.until(lambda browser: browser.execute_script("const image=document.querySelector('.domain-card .tab-icon');return image.src===arguments[0]&&image.complete&&image.naturalWidth>0;", fixture_icon))
        Select(driver.find_element(By.ID, 'group')).select_by_value('none')
        search.clear()
        search.send_keys('tabview smoke')
        wait.until(lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.tab-row')) == 8)
        Select(driver.find_element(By.ID, 'group')).select_by_value('domain')
        wait.until(lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.domain-card')) == 1)
        assert driver.find_element(By.CSS_SELECTOR, '.domain-state').text == '0 loaded · 8 unloaded'
        driver.find_element(By.CSS_SELECTOR, '.domain-open').click()
        wait.until(lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.tab-row')) == 8)
        driver.find_element(By.ID, 'select-all').click()
        driver.find_element(By.ID, 'close-selected').click()
        assert len(driver.find_elements(By.CSS_SELECTOR, '#close-list li')) == 8
        driver.find_element(By.ID, 'confirm-close').click()
        wait.until(lambda browser: '8 closed' in browser.find_element(By.ID, 'status').text)
        batches = rpc({'type': 'recovery'})
        assert len(batches[0]['entries']) == 8
        assert all(entry['status'] == 'closed' for entry in batches[0]['entries'])
        driver.find_element(By.ID, 'recovery-open').click()
        wait.until(lambda browser: browser.find_elements(By.CSS_SELECTOR, '.recovery-batch button'))
        driver.find_element(By.CSS_SELECTOR, '.recovery-batch button').click()
        wait.until(lambda browser: '8 reopened' in browser.find_element(By.ID, 'recovery-status').text)
        reopened = rpc({'type': 'snapshot'})
        assert len([tab for tab in reopened['tabs'] if 'tabview-smoke-' in tab['url']]) == 8
        assert rpc({'type': 'restore', 'id': batches[0]['id'], 'windowId': seeded[0]['windowId']})['reopened'] == 0
        driver.find_element(By.CSS_SELECTOR, '#recovery-dialog [data-dismiss]').click()

        Select(driver.find_element(By.ID, 'group')).select_by_value('none')
        wait.until(lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.tab-row')) == 8)
        before_reload = {tab['url']: (tab['key'], tab.get('openedAt')) for tab in rpc({'type': 'snapshot'})['tabs']}
        dashboard = driver.current_window_handle
        driver.switch_to.new_window('tab')
        blank = driver.current_window_handle
        driver.switch_to.window(dashboard)
        driver.execute_script("browser.runtime.reload();")
        time.sleep(1)
        driver.switch_to.window(blank)
        driver.get(f'moz-extension://{uuid}/index.html')
        wait.until(lambda browser: ' of ' in browser.find_element(By.ID, 'count').text)
        after_reload = rpc({'type': 'snapshot'})
        for tab in after_reload['tabs']:
            if tab['url'] in before_reload:
                assert (tab['key'], tab.get('openedAt')) == before_reload[tab['url']]
        assert len(rpc({'type': 'recovery'})) == 3
        assert after_reload['preferences']['keybindings']['closeSelected'] == 'Delete'
        assert after_reload['preferences']['keybindings']['clearSelection'] == 'Ctrl+K'
        assert driver.execute_async_script("const done=arguments[arguments.length-1];browser.commands.getAll().then(commands=>done(commands.find(c=>c.name==='open-dashboard').shortcut));") == 'Ctrl+Shift+U', 'shortcut must survive extension reload'
        print(json.dumps({'browser': driver.capabilities['browserVersion'], 'close_recovery_reload': 'passed'}))
        driver.execute_async_script("const done = arguments[arguments.length - 1]; (async () => {for (let offset=0;offset<992;offset+=32) await Promise.all(Array.from({length:Math.min(32,992-offset)},(_,n)=>{const i=offset+n;return browser.tabs.create({url:'https://example.com/tabview-performance-'+i,title:'Performance project '+i,discarded:true,active:false});}));done(true);})().catch(e=>done(String(e)));")
        wait.until(lambda browser: len(rpc({'type': 'snapshot'})['tabs']) >= 1000)
        driver.get(f'moz-extension://{uuid}/index.html')
        wait.until(lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.tab-row')) >= 1000)
        first_rect = driver.execute_script("return document.querySelector('.tab-row').getBoundingClientRect().toJSON();")
        viewport = driver.execute_script('return window.innerHeight;')
        actions = ActionChains(driver)
        pointer = actions.w3c_actions.pointer_action
        pointer.move_to_location(int(first_rect['x'] + 60), int(first_rect['y'] + 8))
        pointer.pointer_down()
        pointer.move_to_location(int(first_rect['x'] + 80), viewport - 8)
        pointer.pause(.4)
        pointer.pointer_up()
        actions.perform()
        assert driver.execute_script('return window.scrollY;') > 0, 'drag selection must scroll at the viewport edge'
        driver.find_element(By.ID, 'clear-selection').click()
        driver.execute_script('window.scrollTo(0,0);')
        timing = driver.execute_script("const input=document.querySelector('#search');const start=performance.now(); input.value='performance 991';input.dispatchEvent(new Event('input'));return {milliseconds:performance.now()-start,rows:document.querySelectorAll('.tab-row').length};")
        assert timing['milliseconds'] < 250, timing
        assert timing['rows'] > 0, timing
        driver.execute_script("const input=document.querySelector('#search');input.value='';input.dispatchEvent(new Event('input'));window.scrollTo(0,0);")
        driver.set_window_size(1200, 850)
        driver.save_screenshot(str(root / 'artifacts' / f'dashboard-{"zen" if process else "firefox"}.png'))
        print(json.dumps({'browser': driver.capabilities['browserVersion'], 'integration': 'passed', 'tabs': 1000, 'filter': timing}))
    except Exception:
        try:
            print('PAGE', driver.current_url, driver.find_element(By.TAG_NAME, 'body').text[:1500])
        except Exception:
            pass
        driver.set_context('chrome')
        print('CONSOLE', driver.execute_script("return Services.console.getMessageArray().map(x=>x.message).filter(x=>x.includes('Tabview')||x.includes('moz-extension')||x.includes('Error')).slice(-6).map(x=>x.slice(0,350));"))
        raise
    finally:
        driver.quit()
        icon_server.shutdown()
        icon_server.server_close()
        if process:
            process.terminate()
            process.wait(timeout=10)
