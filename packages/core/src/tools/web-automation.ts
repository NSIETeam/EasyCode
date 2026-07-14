/**
 * @license
 * Copyright 2025 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * Browser automation via Playwright for OA/ERP/web scraping.
 * Ported from Otto project: https://github.com/Felix201209/otto
 *
 * Security: All user inputs (selector, url, script, value) are passed
 * via a JSON data file, never string-interpolated into executable code.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import {
  BaseTool, ToolResult, ToolCallConfirmationDetails,
  Icon, ToolLocation,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config, ApprovalMode } from '../config/config.js';

const execFileAsync = promisify(execFile);

export interface WebAutomationToolParams {
  action: 'navigate' | 'fill' | 'click' | 'scrape' | 'screenshot' | 'run_script' | 'wait' | 'list_tabs' | 'extract_table';
  url?: string;
  selector?: string;
  value?: string;
  extract?: 'text' | 'html' | 'href' | 'src' | 'all';
  clear_first?: boolean;
  wait_for_navigation?: boolean;
  output_path?: string;
  full_page?: boolean;
  timeout_ms?: number;
  script?: string;
  browser?: 'chromium' | 'firefox' | 'webkit';
}

export class WebAutomationTool extends BaseTool<WebAutomationToolParams, ToolResult> {
  static readonly Name: string = 'web_automation';

  constructor(private readonly config: Config) {
    const desc = `Browser automation via Playwright for OA/ERP/web scraping.

EXAMPLES:
  Navigate: {action:"navigate", url:"https://oa.company.com/login"}
  Fill: {action:"fill", selector:"#username", value:"zhangxue"}
  Click: {action:"click", selector:"#login-btn", wait_for_navigation:true}
  Scrape: {action:"scrape", selector:".report-table", extract:"text"}
  Extract table: {action:"extract_table", selector:"table.data"}
  Screenshot: {action:"screenshot", output_path:"~/Desktop/page.png", full_page:true}
  Run JS: {action:"run_script", script:"return document.title"}
  Wait: {action:"wait", selector:"#dashboard", timeout_ms:15000}

DEPENDENCIES: npx playwright install chromium (one-time setup)
CROSS-PLATFORM: Works identically on macOS, Windows, Linux.`;

    super(WebAutomationTool.Name, 'WebAutomation', desc, Icon.Globe,
      {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING, description: 'Browser action to perform', enum: ['navigate', 'fill', 'click', 'scrape', 'screenshot', 'run_script', 'wait', 'list_tabs', 'extract_table'] },
          url: { type: Type.STRING, description: 'URL to navigate to (must start with http:// or https://)' },
          selector: { type: Type.STRING, description: 'CSS selector (e.g. "#username", ".btn-primary", "table.data")' },
          value: { type: Type.STRING, description: 'Text to type into field (for fill action)' },
          extract: { type: Type.STRING, description: 'What to extract', enum: ['text', 'html', 'href', 'src', 'all'] },
          clear_first: { type: Type.BOOLEAN, description: 'Clear field before typing. Default: true' },
          wait_for_navigation: { type: Type.BOOLEAN, description: 'Wait for page load after click. Default: false' },
          output_path: { type: Type.STRING, description: 'Screenshot save path' },
          full_page: { type: Type.BOOLEAN, description: 'Capture full page screenshot. Default: false' },
          timeout_ms: { type: Type.NUMBER, description: 'Wait timeout in ms. Default: 10000' },
          script: { type: Type.STRING, description: 'JavaScript to execute on page (run_script action). Runs in browser context via page.evaluate.' },
          browser: { type: Type.STRING, description: 'Browser engine. Default: chromium', enum: ['chromium', 'firefox', 'webkit'] },
        },
        required: ['action'],
      },
    );
  }

  validateToolParams(p: WebAutomationToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, p, WebAutomationTool.Name);
    if (e) return e;
    const a = p.action;
    if (a === 'navigate' && !p.url) return 'web_automation/navigate: url required';
    if (a === 'navigate' && !/^https?:\/\//.test(p.url!)) return 'web_automation/navigate: url must start with http:// or https://';
    if (['fill', 'click', 'wait', 'scrape', 'extract_table'].includes(a) && !p.selector) return 'web_automation/' + a + ': selector required';
    if (a === 'fill' && p.value === undefined) return 'web_automation/fill: value required';
    if (a === 'run_script' && !p.script) return 'web_automation/run_script: script required';
    if (a === 'scrape' && !p.extract) return 'web_automation/scrape: extract required (text/html/href/src/all)';
    return null;
  }

  toolLocations(p: WebAutomationToolParams): ToolLocation[] { return p.output_path ? [{ path: p.output_path }] : []; }
  getDescription(p: WebAutomationToolParams): string {
    let desc = 'web: ' + p.action;
    if (p.url) desc += ' ' + p.url.substring(0, 50);
    if (p.selector) desc += ' ' + p.selector.substring(0, 30);
    if (p.script) desc += ' script:' + p.script.substring(0, 30);
    return desc;
  }

  async shouldConfirmExecute(p: WebAutomationToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.YOLO) return false;
    if (this.validateToolParams(p)) return false;
    // Show full details for dangerous actions
    const detail = p.script ? `\nScript: ${p.script.substring(0, 200)}` : (p.selector ? `\nSelector: ${p.selector}` : '');
    return { type: 'exec', title: '[WARN] Confirm: ' + this.getDescription(p) + detail, command: 'web_automation(' + p.action + ')', rootCommand: 'web_automation', onConfirm: async () => {} };
  }

  private async preflightPlaywright(): Promise<string | null> {
    try { require.resolve('playwright'); return null; } catch {}
    try { require.resolve('playwright-core'); return null; } catch {}
    return 'web_automation FAIL: Playwright not installed.\nInstall: npm install playwright && npx playwright install chromium';
  }

  async execute(p: WebAutomationToolParams, _s: AbortSignal): Promise<ToolResult> {
    const err = this.validateToolParams(p);
    if (err) return { llmContent: err, returnDisplay: err };
    const depErr = await this.preflightPlaywright();
    if (depErr) return { llmContent: depErr, returnDisplay: 'web_automation FAIL: Playwright not installed' };

    // Create a unique temp directory for this execution
    const tmpDir = path.join(os.tmpdir(), 'easycode-web-' + randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const scriptFile = path.join(tmpDir, 'runner.mjs');
    const dataFile = path.join(tmpDir, 'params.json');
    const stateFile = path.join(tmpDir, 'state.json');

    try {
      // Write user inputs as JSON data (never interpolated into code)
      const params = {
        action: p.action,
        url: p.url,
        selector: p.selector,
        value: p.value,
        extract: p.extract,
        clear_first: p.clear_first !== false,
        wait_for_navigation: p.wait_for_navigation || false,
        output_path: p.output_path || path.join(os.tmpdir(), 'web_screenshot_' + Date.now() + '.png'),
        full_page: p.full_page || false,
        timeout: p.timeout_ms || 10000,
        script: p.script,
        browser: p.browser || 'chromium',
        stateFile,
      };
      fs.writeFileSync(dataFile, JSON.stringify(params), { mode: 0o600 });

      // Write the runner script (static, no user input interpolated)
      fs.writeFileSync(scriptFile, RUNNER_SCRIPT, { mode: 0o600 });

      // Execute via execFile (not exec) to avoid shell parsing
      const { stdout } = await execFileAsync('node', [scriptFile, dataFile], {
        timeout: (p.timeout_ms || 10000) + 30000,
        maxBuffer: 50 * 1024 * 1024,
      });

      const output = stdout.trim();
      if (!output) return { llmContent: 'web_automation FAIL: No output', returnDisplay: 'web_automation FAIL: No output' };

      try {
        const parsed = JSON.parse(output);
        if (parsed.error) return { llmContent: 'web_automation FAIL: ' + parsed.error, returnDisplay: 'web_automation FAIL: ' + parsed.error };
        const summary = parsed.summary || 'completed';
        const data = parsed.data ? '\n\n' + JSON.stringify(parsed.data, null, 2).substring(0, 3000) : '';
        return { llmContent: 'web_automation OK: ' + summary + data, returnDisplay: 'web_automation OK: ' + summary };
      } catch {
        return { llmContent: 'web_automation OK: ' + output.substring(0, 2000), returnDisplay: 'web_automation OK: ' + output.substring(0, 100) };
      }
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      return { llmContent: 'web_automation FAIL: ' + m, returnDisplay: 'web_automation FAIL: ' + m };
    } finally {
      // Always clean up temp files
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}

/**
 * Static runner script — reads params from JSON file, never interpolates user input.
 * This script is constant; all user-provided data (selector, url, script, value)
 * is loaded from params.json and passed as function arguments to Playwright APIs.
 */
const RUNNER_SCRIPT = `import { readFileSync } from 'fs';
import { chromium, firefox, webkit } from 'playwright';

const params = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const engines = { chromium, firefox, webkit };
const engine = engines[params.browser] || chromium;

async function main() {
  const browser = await engine.launch({ headless: true });
  let context;
  try {
    const { existsSync } = await import('fs');
    if (existsSync(params.stateFile)) {
      context = await browser.newContext({ storageState: params.stateFile });
    } else {
      context = await browser.newContext();
    }
  } catch {
    context = await browser.newContext();
  }

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  let result;

  try {
    switch (params.action) {
      case 'navigate':
        await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: params.timeout });
        result = { summary: 'Navigated to ' + params.url.substring(0, 80), data: { url: page.url(), title: await page.title() } };
        break;

      case 'fill': {
        const el = await page.waitForSelector(params.selector, { timeout: params.timeout });
        if (params.clear_first) await el.fill('');
        await el.fill(params.value);
        result = { summary: 'Filled selector', data: { selector: params.selector } };
        break;
      }

      case 'click': {
        const el = await page.waitForSelector(params.selector, { timeout: params.timeout });
        if (params.wait_for_navigation) {
          await Promise.all([page.waitForNavigation({ timeout: params.timeout }).catch(() => {}), el.click()]);
        } else {
          await el.click();
        }
        result = { summary: 'Clicked selector', data: { url: page.url() } };
        break;
      }

      case 'scrape': {
        const el = await page.waitForSelector(params.selector, { timeout: params.timeout });
        if (params.extract === 'all') {
          const text = await el.textContent();
          const html = await el.innerHTML();
          const href = await el.getAttribute('href');
          const src = await el.getAttribute('src');
          result = { summary: 'Scraped all', data: { text: text?.trim()?.substring(0, 5000), html: html?.substring(0, 5000), href, src } };
        } else {
          const extractors = {
            text: () => el.textContent(),
            html: () => el.innerHTML(),
            href: () => el.getAttribute('href'),
            src: () => el.getAttribute('src'),
          };
          const fn = extractors[params.extract] || extractors.text;
          const data = await fn();
          result = { summary: 'Scraped ' + params.extract, data: { [params.extract]: data } };
        }
        break;
      }

      case 'extract_table': {
        const tableData = await page.evaluate((sel) => {
          const table = document.querySelector(sel);
          if (!table) return null;
          const rows = Array.from(table.querySelectorAll('tr'));
          return rows.map(row => Array.from(row.querySelectorAll('td,th')).map(cell => cell.textContent?.trim() || ''));
        }, params.selector);
        result = { summary: 'Extracted table', data: tableData };
        break;
      }

      case 'screenshot': {
        const dir = params.output_path.substring(0, params.output_path.lastIndexOf(/[\\\\/]/.exec(params.output_path)?.index || params.output_path.length));
        try { await import('fs').then(fs => fs.mkdirSync(dir, { recursive: true })); } catch {}
        await page.screenshot({ path: params.output_path, fullPage: params.full_page });
        result = { summary: 'Screenshot saved to ' + params.output_path, data: { path: params.output_path } };
        break;
      }

      case 'run_script': {
        // Script runs in browser context via page.evaluate — sandboxed, no Node.js access
        const fn = new Function('return (async () => { ' + params.script + ' })()');
        const data = await page.evaluate(fn);
        result = { summary: 'Script executed', data };
        break;
      }

      case 'wait':
        await page.waitForSelector(params.selector, { timeout: params.timeout });
        result = { summary: 'Element appeared: ' + params.selector };
        break;

      case 'list_tabs': {
        const allPages = await browser.contexts()[0]?.pages() || [];
        const tabs = await Promise.all(allPages.map(async (p, i) => ({ index: i, url: p.url(), title: await p.title() })));
        result = { summary: tabs.length + ' tabs open', data: tabs };
        break;
      }

      default:
        result = { error: 'Unknown action: ' + params.action };
    }

    try { await context.storageState({ path: params.stateFile }); } catch {}
  } catch (err) {
    result = { error: err.message };
  }

  await browser.close();
  console.log(JSON.stringify(result));
}

main().catch(err => { console.log(JSON.stringify({ error: err.message })); process.exit(1); });
`;
