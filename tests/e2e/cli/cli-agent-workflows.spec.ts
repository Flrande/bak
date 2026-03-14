import { existsSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { expect, test } from '@playwright/test';
import { runCli, runCliFailure, readJsonFile } from '../helpers/cli';
import { createHarness, type E2EHarness } from '../helpers/harness';

let harness: E2EHarness | undefined;

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

function runHarnessCli<T = unknown>(args: string[]): T {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  return runCli(args, harness.rpcPort, harness.dataDir, harness.sessionId);
}

function runHarnessCliFailure(args: string[]): string {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  return runCliFailure(args, harness.rpcPort, harness.dataDir, harness.sessionId);
}

test.describe('CLI agent workflows', () => {
  test.beforeAll(async () => {
    harness = await createHarness();
  });

  test.afterAll(async () => {
    await harness?.dispose();
  });

  test('drives a multi-step form workflow with readback through first-class CLI commands', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/form.html');
    try {
      runHarnessCli(['element', 'type', '--tab-id', String(tabId), '--css', '#name-input', '--value', 'Agent CLI']);
      runHarnessCli(['element', 'type', '--tab-id', String(tabId), '--css', '#email-input', '--value', 'agent@example.com']);
      runHarnessCli(['element', 'focus', '--tab-id', String(tabId), '--css', '#note-input']);
      runHarnessCli(['keyboard', 'type', 'notes via keyboard', '--tab-id', String(tabId)]);
      runHarnessCli(['element', 'select', '--tab-id', String(tabId), '--css', '#role-select', '--value', 'admin']);
      runHarnessCli(['element', 'check', '--tab-id', String(tabId), '--css', '#agree-check']);
      runHarnessCli(['element', 'uncheck', '--tab-id', String(tabId), '--css', '#agree-check']);
      runHarnessCli(['element', 'check', '--tab-id', String(tabId), '--css', '#agree-check']);
      const noteField = runHarnessCli<{ value?: string }>(['element', 'get', '--tab-id', String(tabId), '--css', '#note-input']);
      const checkbox = runHarnessCli<{ checked?: boolean }>(['element', 'get', '--tab-id', String(tabId), '--css', '#agree-check']);

      expect(noteField.value).toBe('notes via keyboard');
      expect(checkbox.checked).toBe(true);

      await expect(page.locator('#name-input')).toHaveValue('Agent CLI');
      await expect(page.locator('#email-input')).toHaveValue('agent@example.com');
      await expect(page.locator('#note-input')).toHaveValue('notes via keyboard');
      await expect(page.locator('#role-select')).toHaveValue('admin');
      await expect(page.locator('#agree-check')).toBeChecked();
    } finally {
      await page.close();
    }
  });

  test('navigates frame and shadow context through the CLI and captures aligned debug snapshot output', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/iframe-host.html');
    try {
      runHarnessCli(['context', 'enter-frame', '--tab-id', String(tabId), '--frame-path', '#demo-frame']);

      const frameUrl = runHarnessCli<{ url: string }>(['page', 'url', '--tab-id', String(tabId)]);
      const frameTitle = runHarnessCli<{ title: string }>(['page', 'title', '--tab-id', String(tabId)]);
      expect(frameUrl.url).toContain('/iframe-child.html');
      expect(frameTitle.title).toContain('Iframe Child');

      runHarnessCli(['element', 'type', '--tab-id', String(tabId), '--css', '#frame-input', '--value', 'frame cli']);
      runHarnessCli(['element', 'click', '--tab-id', String(tabId), '--css', '#frame-btn']);
      await expect(page.frameLocator('#demo-frame').locator('#frame-result')).toContainText('clicked:frame cli');

      runHarnessCli(['context', 'enter-shadow', '--tab-id', String(tabId), '--host-selectors', '#frame-shadow-host']);
      runHarnessCli(['element', 'type', '--tab-id', String(tabId), '--css', '#frame-shadow-input', '--value', 'shadow cli']);
      runHarnessCli(['element', 'click', '--tab-id', String(tabId), '--css', '#frame-shadow-btn']);
      await expect(page.frameLocator('#demo-frame').locator('#frame-result')).toContainText('frame-shadow:shadow cli');

      const dump = runHarnessCli<{
        url: string;
        title: string;
        context: { framePath: string[]; shadowPath: string[] };
        accessibility?: Array<{ name: string }>;
        snapshot?: {
          imagePath: string;
          elementsPath: string;
          elementCount: number;
          annotatedImagePath?: string;
          refs?: Array<{ ref: string; eid: string; actionability: string; name: string; text: string }>;
          actionSummary?: {
            clickable: Array<{ ref: string; eid: string }>;
            inputs: Array<{ ref: string; eid: string }>;
          };
        };
      }>(
        ['debug', 'dump-state', '--tab-id', String(tabId), '--include-a11y', '--include-snapshot', '--annotate-snapshot'],
        harness.rpcPort,
        harness.dataDir
      );

      expect(dump.url).toContain('/iframe-child.html');
      expect(dump.title).toContain('Iframe Child');
      expect(dump.context.framePath).toEqual(['#demo-frame']);
      expect(dump.context.shadowPath).toEqual(['#frame-shadow-host']);
      expect(dump.accessibility?.some((node) => node.name.includes('Frame Shadow Action'))).toBe(true);
      expect(existsSync(must(dump.snapshot, 'Expected dump snapshot').imagePath)).toBe(true);
      expect(existsSync(dump.snapshot!.elementsPath)).toBe(true);
      expect(existsSync(must(dump.snapshot.annotatedImagePath, 'Expected annotated dump snapshot'))).toBe(true);
      expect((dump.snapshot.refs ?? []).length).toBeGreaterThan(0);
      expect((dump.snapshot.actionSummary?.clickable.length ?? 0) > 0 || (dump.snapshot.actionSummary?.inputs.length ?? 0) > 0).toBe(true);

      const shadowInput = must(
        dump.snapshot.refs?.find((ref) => ref.actionability === 'type'),
        `Expected a typed ref in ${JSON.stringify(dump.snapshot.refs)}`
      );
      const shadowAction = must(
        dump.snapshot.refs?.find(
          (ref) => ref.actionability === 'click' && `${ref.name} ${ref.text}`.includes('Frame Shadow Action')
        ),
        `Expected a clickable shadow action ref in ${JSON.stringify(dump.snapshot.refs)}`
      );
      runHarnessCli(['element', 'type', '--tab-id', String(tabId), '--eid', shadowInput.eid, '--value', 'shadow ref', '--clear']);
      runHarnessCli(['element', 'click', '--tab-id', String(tabId), '--eid', shadowAction.eid]);
      await expect(page.frameLocator('#demo-frame').locator('#frame-result')).toContainText('frame-shadow:shadow ref');

      runHarnessCli(['context', 'reset', '--tab-id', String(tabId)]);
      const topLevelUrl = runHarnessCli<{ url: string }>(['page', 'url', '--tab-id', String(tabId)]);
      expect(topLevelUrl.url).toContain('/iframe-host.html');
    } finally {
      await page.close();
    }
  });

  test('uses CLI network and debug commands to inspect request history, console output, and snapshot state', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/network.html');
    try {
      await page.click('#fetch-ok');
      await expect(page.locator('#network-log')).toContainText('fetch:200:');
      await page.click('#fetch-fail');
      await expect(page.locator('#network-log')).toContainText('fetch:503:');

      const list = runHarnessCli<{ entries: Array<{ id: string; status: number; url: string; kind?: string }> }>([
        'network',
        'list',
        '--tab-id',
        String(tabId),
        '--limit',
        '20',
        '--url-includes',
        '/api/slow'
      ]);
      const okEntry = must(
        list.entries.find((entry) => entry.url.includes('status=200')),
        `Expected a 200 request entry in ${JSON.stringify(list.entries)}`
      );
      const failedEntry = must(
        list.entries.find((entry) => entry.url.includes('status=503')),
        `Expected a 503 request entry in ${JSON.stringify(list.entries)}`
      );
      const fetched = runHarnessCli<{ entry: { id: string; status: number; url: string; kind?: string } }>([
        'network',
        'get',
        failedEntry.id,
        '--tab-id',
        String(tabId)
      ]);
      const consoleEntries = runHarnessCli<{ entries: Array<{ level: string; message: string }> }>([
        'debug',
        'console',
        '--tab-id',
        String(tabId),
        '--limit',
        '20'
      ]);
      const dump = runHarnessCli<{
        console: Array<{ level: string; message: string }>;
        network: Array<{ status: number }>;
        snapshot?: { imagePath: string; elementCount: number };
      }>(
        ['debug', 'dump-state', '--tab-id', String(tabId), '--console-limit', '20', '--network-limit', '20', '--include-snapshot'],
        harness.rpcPort,
        harness.dataDir
      );

      expect([0, 200]).toContain(Number(okEntry.status));
      expect([0, 503]).toContain(Number(failedEntry.status));
      if (Number(okEntry.status) === 0) {
        expect(['fetch', 'resource']).toContain(okEntry.kind);
      }
      if (Number(failedEntry.status) === 0) {
        expect(['fetch', 'resource']).toContain(failedEntry.kind);
      }
      expect(fetched.entry.id).toBe(failedEntry.id);
      expect(fetched.entry.url).toContain('status=503');
      expect(Array.isArray(consoleEntries.entries)).toBe(true);
      expect(
        dump.network.some((entry) => entry.status === 503)
        || dump.network.some((entry) => entry.status === 0)
      ).toBe(true);
      expect(Array.isArray(dump.console)).toBe(true);
      expect(existsSync(must(dump.snapshot, 'Expected dump snapshot').imagePath)).toBe(true);

      runHarnessCli(['network', 'clear', '--tab-id', String(tabId)]);
      const cleared = runHarnessCli<{ entries: Array<unknown> }>(['network', 'list', '--tab-id', String(tabId), '--limit', '5']);
      expect(cleared.entries).toHaveLength(0);
    } finally {
      await page.close();
    }
  });

  test('uploads a file and captures a base64-enabled page snapshot through the CLI', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/upload.html');
    try {
      const filesJson = JSON.stringify({
        items: [
          {
            name: 'agent-upload.txt',
            mimeType: 'text/plain',
            contentBase64: Buffer.from('uploaded from cli', 'utf8').toString('base64')
          }
        ]
      });
      runHarnessCli(['file', 'upload', '--tab-id', String(tabId), '--css', '#file-input', '--files', filesJson]);
      await expect(page.locator('#upload-result')).toContainText('files:1');

      const previousElementsPath = `${harness.dataDir}\\previous-upload-elements.json`;
      writeFileSync(
        previousElementsPath,
        `${JSON.stringify(
          [
            {
              eid: 'previous-upload',
              tag: 'input',
              role: 'textbox',
              name: 'Previous Upload Input',
              text: '',
              bbox: { x: 80, y: 80, width: 120, height: 40 },
              selectors: {
                css: '#file-input',
                xpath: null,
                text: null,
                aria: 'textbox "Previous Upload Input"'
              },
              risk: 'low'
            }
          ],
          null,
          2
        )}\n`,
        'utf8'
      );
      const previousSnapshotPath = `${harness.dataDir}\\previous-upload-snapshot.json`;
      writeFileSync(
        previousSnapshotPath,
        `${JSON.stringify(
          {
            elementsPath: previousElementsPath
          },
          null,
          2
        )}\n`,
        'utf8'
      );

      const snapshot = runHarnessCli<{
        imagePath: string;
        elementsPath: string;
        imageBase64?: string;
        annotatedImagePath?: string;
        annotatedImageBase64?: string;
        elementCount: number;
        refs?: Array<{ ref: string; eid: string; actionability: string }>;
        actionSummary?: { inputs: Array<{ ref: string; eid: string }>; recommendedNextActions: Array<{ ref: string }> };
        diff?: { summary: { changed: number } };
      }>(['page', 'snapshot', '--tab-id', String(tabId), '--include-base64', '--annotate', '--diff-with', previousSnapshotPath]);
      const a11y = runHarnessCli<{ nodes: Array<{ role: string }> }>(['page', 'a11y', '--tab-id', String(tabId)]);
      const elements = readJsonFile<Array<unknown>>(snapshot.elementsPath);

      expect(existsSync(snapshot.imagePath)).toBe(true);
      expect(existsSync(snapshot.elementsPath)).toBe(true);
      expect(existsSync(must(snapshot.annotatedImagePath, 'Expected annotated snapshot path'))).toBe(true);
      expect(snapshot.imageBase64).toBeTruthy();
      expect(snapshot.annotatedImageBase64).toBeTruthy();
      expect(snapshot.elementCount).toBeGreaterThan(0);
      expect(elements.length).toBe(snapshot.elementCount);
      expect((snapshot.refs ?? []).length).toBeGreaterThan(0);
      expect((snapshot.actionSummary?.inputs.length ?? 0) > 0 || (snapshot.actionSummary?.recommendedNextActions.length ?? 0) > 0).toBe(true);
      expect(snapshot.diff?.summary.changed).toBeGreaterThanOrEqual(1);
      expect(a11y.nodes.some((node) => node.role === 'textbox')).toBe(true);
    } finally {
      await page.close();
    }
  });

  test('surfaces CLI failure paths for invalid locators and request timeouts', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const controlled = await harness.openPage('/controlled.html');
    try {
      const clickError = runHarnessCliFailure(['element', 'click', '--tab-id', String(controlled.tabId), '--css', '#missing-node']);
      expect(clickError).toMatch(/not found/i);
    } finally {
      await controlled.page.close();
    }

    const network = await harness.openPage('/network.html');
    try {
      const waitError = runHarnessCliFailure(['network', 'wait', '--tab-id', String(network.tabId), '--url-includes', '/never', '--timeout-ms', '250']);
      expect(waitError).toMatch(/timeout/i);
    } finally {
      await network.page.close();
    }
  });
});
