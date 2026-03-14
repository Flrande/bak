interface RowItem {
  id: number;
  name: string;
}

interface QueuedTask {
  id: number;
  title: string;
}

interface VirtualRowItem {
  id: number;
  name: string;
  bucket: string;
}

interface NetworkTableRow {
  id: number;
  symbol: string;
  side: string;
  premium: number;
}

declare global {
  interface Window {
    table_data?: Array<RowItem>;
    market_data?: Record<string, unknown>;
    top_table_row?: RowItem | null;
    darkpool_json_data?: Record<string, unknown>;
    latestNetworkData?: Record<string, unknown>;
    latestNetworkTimestamp?: string;
    frame_table_data?: Array<{ id: number; name: string }>;
  }
}

const page = document.body.dataset.page;

function initFormPage(): void {
  const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
  const result = document.getElementById('result') as HTMLDivElement;
  const dragSource = document.getElementById('drag-source') as HTMLDivElement;
  const dropTarget = document.getElementById('drop-target') as HTMLDivElement;
  const dragResult = document.getElementById('drag-result') as HTMLDivElement;

  const nameInput = document.getElementById('name-input') as HTMLInputElement;
  const emailInput = document.getElementById('email-input') as HTMLInputElement;
  const noteInput = document.getElementById('note-input') as HTMLTextAreaElement;

  saveBtn.addEventListener('click', () => {
    const payload = {
      name: nameInput.value,
      email: emailInput.value,
      note: noteInput.value,
      savedAt: new Date().toISOString()
    };
    localStorage.setItem('bak:lastFormPayload', JSON.stringify(payload));
    result.textContent = `Saved ${payload.name || 'Anonymous'} @ ${payload.savedAt}`;
    result.dataset.status = 'saved';
  });

  cancelBtn.addEventListener('click', () => {
    nameInput.value = '';
    emailInput.value = '';
    noteInput.value = '';
    result.textContent = 'Reset done';
    result.dataset.status = 'reset';
  });

  dragSource.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData('text/plain', dragSource.id);
    dragResult.textContent = 'drag:started';
  });
  dropTarget.addEventListener('dragenter', (event) => {
    event.preventDefault();
  });
  dropTarget.addEventListener('dragover', (event) => {
    event.preventDefault();
  });
  dropTarget.addEventListener('drop', (event) => {
    event.preventDefault();
    const sourceId = event.dataTransfer?.getData('text/plain') || 'unknown';
    dragResult.textContent = `drag:${sourceId}->${dropTarget.id}`;
  });
}

function initTablePage(): void {
  const rows: RowItem[] = [
    { id: 1, name: 'Alpha' },
    { id: 2, name: 'Beta' },
    { id: 3, name: 'Gamma' }
  ];

  const tbody = document.getElementById('rows') as HTMLTableSectionElement;
  const modal = document.getElementById('modal') as HTMLDivElement;
  const modalText = document.getElementById('modal-text') as HTMLParagraphElement;
  const confirmDelete = document.getElementById('confirm-delete') as HTMLButtonElement;
  const cancelDelete = document.getElementById('cancel-delete') as HTMLButtonElement;

  let pendingDeleteId: number | null = null;

  const syncRuntimeState = (): void => {
    window.table_data = rows.map((row) => ({ ...row }));
    window.top_table_row = rows[0] ? { ...rows[0] } : null;
    window.market_data = {
      QQQ: {
        quotes: {
          changePercent: 1.23,
          asOf: '2026-03-05'
        }
      }
    };
  };

  const render = (): void => {
    tbody.innerHTML = '';
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${row.id}</td><td>${row.name}</td><td><button data-id="${row.id}" class="danger delete-btn">删除</button></td>`;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll<HTMLButtonElement>('.delete-btn').forEach((button) => {
      button.addEventListener('click', () => {
        pendingDeleteId = Number.parseInt(button.dataset.id ?? '', 10);
        modal.style.display = 'flex';
        modalText.textContent = `确认删除 #${pendingDeleteId}?`;
      });
    });
    syncRuntimeState();
  };

  cancelDelete.addEventListener('click', () => {
    pendingDeleteId = null;
    modal.style.display = 'none';
  });

  confirmDelete.addEventListener('click', () => {
    if (pendingDeleteId !== null) {
      const index = rows.findIndex((item) => item.id === pendingDeleteId);
      if (index >= 0) {
        rows.splice(index, 1);
      }
      pendingDeleteId = null;
      modal.style.display = 'none';
      render();
    }
  });

  render();
}

function initControlledPage(): void {
  const controlled = document.getElementById('controlled-input') as HTMLInputElement;
  const mirror = document.getElementById('controlled-mirror') as HTMLDivElement;
  const setterLog = document.getElementById('setter-log') as HTMLDivElement;
  const blockedAction = document.getElementById('blocked-action') as HTMLButtonElement;
  const cover = document.getElementById('cover') as HTMLDivElement;
  const toggleCover = document.getElementById('toggle-cover') as HTMLButtonElement;
  const swapAction = document.getElementById('swap-action') as HTMLButtonElement;
  const driftActionHost = document.getElementById('drift-action-host') as HTMLDivElement;
  const actionVariant = document.getElementById('action-variant') as HTMLDivElement;
  const result = document.getElementById('action-result') as HTMLDivElement;
  let driftVariant: 'primary' | 'secondary' = 'primary';

  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  let instanceSetterWrites = 0;

  if (descriptor?.get && descriptor?.set) {
    Object.defineProperty(controlled, 'value', {
      configurable: true,
      get(this: HTMLInputElement) {
        return descriptor.get!.call(this) as string;
      },
      set(this: HTMLInputElement, next: string) {
        instanceSetterWrites += 1;
        setterLog.textContent = `instanceSetterWrites: ${instanceSetterWrites}`;
        this.setAttribute('data-instance-write', next);
      }
    });
  }

  controlled.addEventListener('input', () => {
    mirror.textContent = `mirror: ${controlled.value}`;
  });

  blockedAction.addEventListener('click', () => {
    result.textContent = `result: clicked @ ${Date.now()}`;
  });

  toggleCover.addEventListener('click', () => {
    cover.style.display = cover.style.display === 'none' ? 'block' : 'none';
  });

  const renderDriftAction = (): void => {
    driftActionHost.dataset.variant = driftVariant;
    driftActionHost.innerHTML =
      driftVariant === 'primary'
        ? '<button id="action-primary" data-variant="primary">Run Action</button>'
        : '<button id="action-primary-v2" data-variant="secondary">Run Action</button>';
    actionVariant.textContent = `actionVariant: ${driftVariant}`;
    const actionButton = driftActionHost.querySelector('button') as HTMLButtonElement | null;
    actionButton?.addEventListener('click', () => {
      result.textContent = `result:${actionButton.dataset.variant}@${Date.now()}`;
    });
  };

  swapAction.addEventListener('click', () => {
    driftVariant = driftVariant === 'primary' ? 'secondary' : 'primary';
    renderDriftAction();
  });

  renderDriftAction();
}

function initSpaPage(): void {
  const routeLabel = document.getElementById('route-label') as HTMLDivElement;
  const panelTitle = document.getElementById('panel-title') as HTMLHeadingElement;
  const panelBody = document.getElementById('panel-body') as HTMLParagraphElement;
  const spinner = document.getElementById('route-spinner') as HTMLDivElement;
  const tabDashboard = document.getElementById('tab-dashboard') as HTMLButtonElement;
  const tabAutomation = document.getElementById('tab-automation') as HTMLButtonElement;
  const taskInput = document.getElementById('task-input') as HTMLInputElement;
  const queueBtn = document.getElementById('queue-btn') as HTMLButtonElement;
  const taskList = document.getElementById('task-list') as HTMLUListElement;
  const queueStatus = document.getElementById('queue-status') as HTMLDivElement;

  let activeRoute: 'dashboard' | 'automation' = 'dashboard';
  let taskSeq = 1;
  const tasks: QueuedTask[] = [];

  const setRouteLoading = (loading: boolean): void => {
    spinner.style.display = loading ? 'block' : 'none';
  };

  const renderTasks = (): void => {
    taskList.innerHTML = '';
    for (const task of tasks) {
      const li = document.createElement('li');
      li.dataset.taskId = String(task.id);
      li.textContent = `${task.id}. ${task.title}`;
      taskList.appendChild(li);
    }
  };

  const updateQueueButtonState = (): void => {
    queueBtn.disabled = taskInput.value.trim().length < 3;
  };

  const renderRoute = (): void => {
    routeLabel.textContent = `Route: ${activeRoute}`;
    if (activeRoute === 'dashboard') {
      panelTitle.textContent = 'Dashboard';
      panelBody.textContent = 'Overview widgets are refreshed client-side.';
      return;
    }
    panelTitle.textContent = 'Automation Console';
    panelBody.textContent = 'Queue a task to simulate async SPA rendering.';
  };

  const navigate = (route: 'dashboard' | 'automation'): void => {
    if (route === activeRoute) {
      return;
    }
    setRouteLoading(true);
    window.setTimeout(() => {
      activeRoute = route;
      renderRoute();
      setRouteLoading(false);
    }, 350);
  };

  tabDashboard.addEventListener('click', () => navigate('dashboard'));
  tabAutomation.addEventListener('click', () => navigate('automation'));

  taskInput.addEventListener('input', () => {
    queueStatus.textContent = `draft: ${taskInput.value.trim() || '(empty)'}`;
    updateQueueButtonState();
  });

  queueBtn.addEventListener('click', () => {
    const title = taskInput.value.trim();
    if (title.length < 3) {
      queueStatus.textContent = 'task title too short';
      updateQueueButtonState();
      return;
    }

    queueBtn.disabled = true;
    queueStatus.textContent = 'queueing task...';
    window.setTimeout(() => {
      tasks.push({
        id: taskSeq++,
        title
      });
      renderTasks();
      queueStatus.textContent = `queued ${title}`;
      taskInput.value = '';
      updateQueueButtonState();
    }, 450);
  });

  renderRoute();
  renderTasks();
  updateQueueButtonState();
}

function initIframeHostPage(): void {
  const ping = document.getElementById('host-ping') as HTMLButtonElement;
  const status = document.getElementById('host-status') as HTMLDivElement;
  ping.addEventListener('click', () => {
    status.textContent = `host:ping@${Date.now()}`;
  });
}

function initShadowPage(): void {
  const host = document.getElementById('shadow-host') as HTMLDivElement;
  const status = document.getElementById('shadow-status') as HTMLDivElement;
  const shadow = host.attachShadow({ mode: 'open' });
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <style>
      .shadow-wrap { border: 1px solid #94a3b8; border-radius: 8px; padding: 12px; background: #fff7ed; }
      .shadow-btn { border: none; border-radius: 6px; padding: 8px 12px; background: #ea580c; color: white; cursor: pointer; }
      .shadow-input { margin-top: 8px; width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #94a3b8; border-radius: 6px; }
    </style>
    <div class="shadow-wrap">
      <button id="shadow-btn" class="shadow-btn">Shadow Action</button>
      <input id="shadow-input" class="shadow-input" placeholder="shadow value" />
      <div id="inner-shadow-host"></div>
    </div>
  `;
  shadow.appendChild(wrapper);

  const button = shadow.getElementById('shadow-btn') as HTMLButtonElement;
  const input = shadow.getElementById('shadow-input') as HTMLInputElement;
  const innerHost = shadow.getElementById('inner-shadow-host') as HTMLDivElement;
  const innerShadow = innerHost.attachShadow({ mode: 'open' });
  const innerWrapper = document.createElement('div');
  innerWrapper.innerHTML = `
    <style>
      .inner-shadow-wrap { margin-top: 12px; border-top: 1px dashed #fb923c; padding-top: 12px; }
      .inner-shadow-btn { border: none; border-radius: 6px; padding: 8px 12px; background: #9a3412; color: white; cursor: pointer; }
      .inner-shadow-input { margin-top: 8px; width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #7c2d12; border-radius: 6px; }
    </style>
    <div class="inner-shadow-wrap">
      <button id="inner-shadow-btn" class="inner-shadow-btn">Inner Shadow Action</button>
      <input id="inner-shadow-input" class="inner-shadow-input" placeholder="inner shadow value" />
    </div>
  `;
  innerShadow.appendChild(innerWrapper);

  button.addEventListener('click', () => {
    status.textContent = `shadow:${input.value || '(empty)'}`;
  });
  const innerButton = innerShadow.getElementById('inner-shadow-btn') as HTMLButtonElement;
  const innerInput = innerShadow.getElementById('inner-shadow-input') as HTMLInputElement;
  innerButton.addEventListener('click', () => {
    status.textContent = `nested-shadow:${innerInput.value || '(empty)'}`;
  });
}

function initUploadPage(): void {
  const input = document.getElementById('file-input') as HTMLInputElement;
  const result = document.getElementById('upload-result') as HTMLDivElement;
  input.addEventListener('change', () => {
    result.textContent = `files:${input.files?.length ?? 0}`;
  });
}

function initNetworkPage(): void {
  const okButton = document.getElementById('fetch-ok') as HTMLButtonElement;
  const failButton = document.getElementById('fetch-fail') as HTMLButtonElement;
  const log = document.getElementById('network-log') as HTMLDivElement;
  window.darkpool_json_data = {
    updatedAt: '2026-03-05',
    flows: [{ symbol: 'QQQ', side: 'buy', premium: 125000 }]
  };

  const request = async (status: number): Promise<void> => {
    log.textContent = `fetch:${status}:pending`;
    console.info(`network request started: ${status}`);
    try {
      const response = await fetch(`/api/slow?delay=250&status=${status}`);
      const payload = (await response.json()) as { status: number; ok: boolean; generatedAt: string; symbol: string };
      window.latestNetworkData = payload as unknown as Record<string, unknown>;
      window.latestNetworkTimestamp = payload.generatedAt;
      log.textContent = `fetch:${payload.status}:${payload.ok ? 'ok' : 'fail'}`;
      if (payload.ok) {
        console.info(`network request ok: ${payload.status}`);
      } else {
        console.warn(`network request failed: ${payload.status}`);
      }
    } catch (error) {
      log.textContent = `fetch:${status}:error:${error instanceof Error ? error.message : String(error)}`;
      console.error(`network request error: ${status}`, error);
    }
  };

  okButton.addEventListener('click', () => {
    void request(200);
  });
  failButton.addEventListener('click', () => {
    void request(503);
  });
}

function initVirtualTablePage(): void {
  const viewport = document.getElementById('virtual-grid') as HTMLDivElement;
  const inner = document.getElementById('virtual-grid-inner') as HTMLDivElement;
  const status = document.getElementById('virtual-grid-status') as HTMLDivElement;
  const rowHeight = 44;
  const overscan = 2;
  const rows: VirtualRowItem[] = Array.from({ length: 40 }, (_, index) => ({
    id: index + 1,
    name: `Virtual Row ${index + 1}`,
    bucket: index % 2 === 0 ? 'Primary' : 'Secondary'
  }));

  inner.style.height = `${rows.length * rowHeight}px`;

  const render = (): void => {
    const startIndex = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - overscan);
    const visibleCount = Math.ceil(viewport.clientHeight / rowHeight) + overscan * 2;
    const slice = rows.slice(startIndex, startIndex + visibleCount);
    inner.innerHTML = '';
    for (const [offset, row] of slice.entries()) {
      const absoluteIndex = startIndex + offset;
      const rowElement = document.createElement('div');
      rowElement.className = 'grid-row';
      rowElement.setAttribute('role', 'row');
      rowElement.setAttribute('aria-rowindex', String(absoluteIndex + 1));
      rowElement.dataset.rowIndex = String(absoluteIndex + 1);
      rowElement.style.transform = `translateY(${absoluteIndex * rowHeight}px)`;
      rowElement.innerHTML = `
        <div role="gridcell">${row.id}</div>
        <div role="gridcell">${row.name}</div>
        <div role="gridcell">${row.bucket}</div>
      `;
      inner.appendChild(rowElement);
    }
    status.textContent = `mounted ${slice.length} / ${rows.length}`;
  };

  viewport.addEventListener('scroll', () => {
    render();
  });

  render();
}

function initNetworkTablePage(): void {
  const tbody = document.getElementById('network-table-rows') as HTMLTableSectionElement;
  const status = document.getElementById('network-table-status') as HTMLDivElement;

  const render = (rows: NetworkTableRow[]): void => {
    tbody.innerHTML = '';
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${row.id}</td>
        <td>${row.symbol}</td>
        <td>${row.side}</td>
        <td>${row.premium}</td>
      `;
      tbody.appendChild(tr);
    }
  };

  void fetch('/api/network-table-rows')
    .then(async (response) => {
      const payload = (await response.json()) as { rows: NetworkTableRow[]; generatedAt: string };
      render(payload.rows);
      status.textContent = `loaded ${payload.rows.length} rows @ ${payload.generatedAt}`;
    })
    .catch((error: unknown) => {
      status.textContent = `error: ${error instanceof Error ? error.message : String(error)}`;
    });
}

if (page === 'form') {
  initFormPage();
}

if (page === 'table') {
  initTablePage();
}

if (page === 'controlled') {
  initControlledPage();
}

if (page === 'spa') {
  initSpaPage();
}

if (page === 'iframe-host') {
  initIframeHostPage();
}

if (page === 'shadow') {
  initShadowPage();
}

if (page === 'upload') {
  initUploadPage();
}

if (page === 'network') {
  initNetworkPage();
}

if (page === 'virtual-table') {
  initVirtualTablePage();
}

if (page === 'network-table') {
  initNetworkTablePage();
}
