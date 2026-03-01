interface RowItem {
  id: number;
  name: string;
}

interface QueuedTask {
  id: number;
  title: string;
}

const page = document.body.dataset.page;

function initFormPage(): void {
  const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
  const result = document.getElementById('result') as HTMLDivElement;

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
  const result = document.getElementById('action-result') as HTMLDivElement;

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
