import { existsSync } from 'node:fs';
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

function captureAndPromoteActionMemory(tabId: number, goal: string, actionCss: string): { id: string; kind: string } {
  if (!harness) {
    throw new Error('Harness not initialized');
  }

  runCli(['memory', 'capture', 'begin', '--goal', goal, '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir);
  runCli(
    ['memory', 'capture', 'mark', '--tab-id', String(tabId), '--label', 'run drift action', '--role', 'procedure'],
    harness.rpcPort,
    harness.dataDir
  );
  runCli(['element', 'click', '--tab-id', String(tabId), '--css', actionCss], harness.rpcPort, harness.dataDir);
  const ended = runCli<{ drafts: Array<{ id: string; kind: string }> }>(
    ['memory', 'capture', 'end', '--tab-id', String(tabId), '--outcome', 'completed'],
    harness.rpcPort,
    harness.dataDir
  );
  const procedureDraft =
    ended.drafts.find((draft) => draft.kind === 'procedure')
    ?? ended.drafts.find((draft) => draft.kind === 'composite')
    ?? ended.drafts[0];
  const promoted = runCli<{ memory: { id: string } }>(
    ['memory', 'draft', 'promote', must(procedureDraft, 'Expected a draft carrying the captured action').id],
    harness.rpcPort,
    harness.dataDir
  );
  return { id: promoted.memory.id, kind: must(procedureDraft, 'Expected promoted draft').kind };
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
      runCli(['element', 'type', '--tab-id', String(tabId), '--css', '#name-input', '--value', 'Agent CLI'], harness.rpcPort, harness.dataDir);
      runCli(
        ['element', 'type', '--tab-id', String(tabId), '--css', '#email-input', '--value', 'agent@example.com'],
        harness.rpcPort,
        harness.dataDir
      );
      runCli(['element', 'focus', '--tab-id', String(tabId), '--css', '#note-input'], harness.rpcPort, harness.dataDir);
      runCli(['keyboard', 'type', 'notes via keyboard', '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir);
      runCli(['element', 'select', '--tab-id', String(tabId), '--css', '#role-select', '--value', 'admin'], harness.rpcPort, harness.dataDir);
      runCli(['element', 'check', '--tab-id', String(tabId), '--css', '#agree-check'], harness.rpcPort, harness.dataDir);
      runCli(['element', 'uncheck', '--tab-id', String(tabId), '--css', '#agree-check'], harness.rpcPort, harness.dataDir);
      runCli(['element', 'check', '--tab-id', String(tabId), '--css', '#agree-check'], harness.rpcPort, harness.dataDir);
      const noteField = runCli<{ value?: string }>(['element', 'get', '--tab-id', String(tabId), '--css', '#note-input'], harness.rpcPort, harness.dataDir);
      const checkbox = runCli<{ checked?: boolean }>(['element', 'get', '--tab-id', String(tabId), '--css', '#agree-check'], harness.rpcPort, harness.dataDir);

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
      runCli(['context', 'enter-frame', '--tab-id', String(tabId), '--frame-path', '#demo-frame'], harness.rpcPort, harness.dataDir);

      const frameUrl = runCli<{ url: string }>(['page', 'url', '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir);
      const frameTitle = runCli<{ title: string }>(['page', 'title', '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir);
      expect(frameUrl.url).toContain('/iframe-child.html');
      expect(frameTitle.title).toContain('Iframe Child');

      runCli(['element', 'type', '--tab-id', String(tabId), '--css', '#frame-input', '--value', 'frame cli'], harness.rpcPort, harness.dataDir);
      runCli(['element', 'click', '--tab-id', String(tabId), '--css', '#frame-btn'], harness.rpcPort, harness.dataDir);
      await expect(page.frameLocator('#demo-frame').locator('#frame-result')).toContainText('clicked:frame cli');

      runCli(['context', 'enter-shadow', '--tab-id', String(tabId), '--host-selectors', '#frame-shadow-host'], harness.rpcPort, harness.dataDir);
      runCli(
        ['element', 'type', '--tab-id', String(tabId), '--css', '#frame-shadow-input', '--value', 'shadow cli'],
        harness.rpcPort,
        harness.dataDir
      );
      runCli(['element', 'click', '--tab-id', String(tabId), '--css', '#frame-shadow-btn'], harness.rpcPort, harness.dataDir);
      await expect(page.frameLocator('#demo-frame').locator('#frame-result')).toContainText('frame-shadow:shadow cli');

      const dump = runCli<{
        url: string;
        title: string;
        context: { framePath: string[]; shadowPath: string[] };
        accessibility?: Array<{ name: string }>;
        snapshot?: { imagePath: string; elementsPath: string; elementCount: number };
      }>(
        ['debug', 'dump-state', '--tab-id', String(tabId), '--include-a11y', '--include-snapshot'],
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

      runCli(['context', 'reset', '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir);
      const topLevelUrl = runCli<{ url: string }>(['page', 'url', '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir);
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

      const list = runCli<{ entries: Array<{ id: string; status: number; url: string; kind?: string }> }>(
        ['network', 'list', '--tab-id', String(tabId), '--limit', '20', '--url-includes', '/api/slow'],
        harness.rpcPort,
        harness.dataDir
      );
      const okEntry = must(
        list.entries.find((entry) => entry.url.includes('status=200')),
        `Expected a 200 request entry in ${JSON.stringify(list.entries)}`
      );
      const failedEntry = must(
        list.entries.find((entry) => entry.url.includes('status=503')),
        `Expected a 503 request entry in ${JSON.stringify(list.entries)}`
      );
      const fetched = runCli<{ entry: { id: string; status: number; url: string; kind?: string } }>(
        ['network', 'get', failedEntry.id, '--tab-id', String(tabId)],
        harness.rpcPort,
        harness.dataDir
      );
      const consoleEntries = runCli<{ entries: Array<{ level: string; message: string }> }>(
        ['debug', 'console', '--tab-id', String(tabId), '--limit', '20'],
        harness.rpcPort,
        harness.dataDir
      );
      const dump = runCli<{
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
        expect(okEntry.kind).toBe('resource');
      }
      if (Number(failedEntry.status) === 0) {
        expect(failedEntry.kind).toBe('resource');
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

      runCli(['network', 'clear', '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir);
      const cleared = runCli<{ entries: Array<unknown> }>(['network', 'list', '--tab-id', String(tabId), '--limit', '5'], harness.rpcPort, harness.dataDir);
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
      runCli(['file', 'upload', '--tab-id', String(tabId), '--css', '#file-input', '--files', filesJson], harness.rpcPort, harness.dataDir);
      await expect(page.locator('#upload-result')).toContainText('files:1');

      const snapshot = runCli<{
        imagePath: string;
        elementsPath: string;
        imageBase64?: string;
        elementCount: number;
      }>(['page', 'snapshot', '--tab-id', String(tabId), '--include-base64'], harness.rpcPort, harness.dataDir);
      const a11y = runCli<{ nodes: Array<{ role: string }> }>(['page', 'a11y', '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir);
      const elements = readJsonFile<Array<unknown>>(snapshot.elementsPath);

      expect(existsSync(snapshot.imagePath)).toBe(true);
      expect(existsSync(snapshot.elementsPath)).toBe(true);
      expect(snapshot.imageBase64).toBeTruthy();
      expect(snapshot.elementCount).toBeGreaterThan(0);
      expect(elements.length).toBe(snapshot.elementCount);
      expect(a11y.nodes.some((node) => node.role === 'textbox')).toBe(true);
    } finally {
      await page.close();
    }
  });

  test('captures a drift-prone procedure, applies a patch suggestion, and reruns successfully through the CLI', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/controlled.html');
    try {
      const memory = captureAndPromoteActionMemory(tabId, 'run drift action', '#action-primary');
      await expect(page.locator('#action-result')).toContainText('result:primary@');

      runCli(['element', 'click', '--tab-id', String(tabId), '--css', '#swap-action'], harness.rpcPort, harness.dataDir);
      await expect(page.locator('#action-variant')).toContainText('secondary');

      const plan = runCli<{ plan: { id: string } }>(
        ['memory', 'plan', 'create', '--memory-id', memory.id, '--tab-id', String(tabId), '--mode', 'auto'],
        harness.rpcPort,
        harness.dataDir
      );
      const failedRun = runCli<{ run: { status: string; patchSuggestionIds: string[] } }>(
        ['memory', 'execute', plan.plan.id, '--tab-id', String(tabId), '--mode', 'auto'],
        harness.rpcPort,
        harness.dataDir
      );
      const patchId = must(failedRun.run.patchSuggestionIds[0], 'Expected a patch suggestion');
      expect(failedRun.run.status).toBe('failed');

      const patch = runCli<{ patch: { id: string; status: string; summary: string } }>(['memory', 'patch', 'show', patchId], harness.rpcPort, harness.dataDir);
      expect(patch.patch.status).toBe('open');
      expect(patch.patch.summary).toMatch(/drift/i);

      const applied = runCli<{ patch: { status: string }; revision: { id: string } }>(
        ['memory', 'patch', 'apply', patchId, '--note', 'accept drift repair'],
        harness.rpcPort,
        harness.dataDir
      );
      expect(applied.patch.status).toBe('applied');
      expect(applied.revision.id).toBeTruthy();

      const rerunPlan = runCli<{ plan: { id: string } }>(
        ['memory', 'plan', 'create', '--memory-id', memory.id, '--tab-id', String(tabId), '--mode', 'auto'],
        harness.rpcPort,
        harness.dataDir
      );
      const rerun = runCli<{ run: { status: string } }>(
        ['memory', 'execute', rerunPlan.plan.id, '--tab-id', String(tabId), '--mode', 'auto'],
        harness.rpcPort,
        harness.dataDir
      );
      expect(rerun.run.status).toBe('completed');
      await expect(page.locator('#action-result')).toContainText('result:secondary@');
    } finally {
      await page.close();
    }
  });

  test('surfaces CLI failure paths for patch rejection, invalid locators, and request timeouts', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const controlled = await harness.openPage('/controlled.html');
    try {
      const memory = captureAndPromoteActionMemory(controlled.tabId, 'reject drift patch', '#action-primary');
      runCli(['element', 'click', '--tab-id', String(controlled.tabId), '--css', '#swap-action'], harness.rpcPort, harness.dataDir);

      const plan = runCli<{ plan: { id: string } }>(
        ['memory', 'plan', 'create', '--memory-id', memory.id, '--tab-id', String(controlled.tabId), '--mode', 'auto'],
        harness.rpcPort,
        harness.dataDir
      );
      const failedRun = runCli<{ run: { patchSuggestionIds: string[] } }>(
        ['memory', 'execute', plan.plan.id, '--tab-id', String(controlled.tabId), '--mode', 'auto'],
        harness.rpcPort,
        harness.dataDir
      );
      const patchId = must(failedRun.run.patchSuggestionIds[0], 'Expected a patch suggestion');

      const rejected = runCli<{ patch: { status: string } }>(
        ['memory', 'patch', 'reject', patchId, '--reason', 'unsafe patch'],
        harness.rpcPort,
        harness.dataDir
      );
      expect(rejected.patch.status).toBe('rejected');

      const patchApplyError = runCliFailure(['memory', 'patch', 'apply', patchId], harness.rpcPort, harness.dataDir);
      expect(patchApplyError).toMatch(/already resolved/i);

      const clickError = runCliFailure(['element', 'click', '--tab-id', String(controlled.tabId), '--css', '#missing-node'], harness.rpcPort, harness.dataDir);
      expect(clickError).toMatch(/not found/i);
    } finally {
      await controlled.page.close();
    }

    const network = await harness.openPage('/network.html');
    try {
      const waitError = runCliFailure(
        ['network', 'wait', '--tab-id', String(network.tabId), '--url-includes', '/never', '--timeout-ms', '250'],
        harness.rpcPort,
        harness.dataDir
      );
      expect(waitError).toMatch(/timeout/i);
    } finally {
      await network.page.close();
    }
  });
});
