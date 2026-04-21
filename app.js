// ==================== SQLite DATA LAYER ====================
let db = null;
let SQL = null;
let serverAvailable = false; // Whether the Python server is running

// Check if we're running via the local server
async function checkServer() {
    try {
        const resp = await fetch('/api/status', { method: 'GET', signal: AbortSignal.timeout(1000) });
        if (resp.ok) {
            const json = await resp.json();
            serverAvailable = true;
            return json;
        }
    } catch (e) {
        // Server not available (file:// or no server running)
    }
    serverAvailable = false;
    return null;
}

// Load DB from the server file on disk
async function loadDbFromServer() {
    try {
        const resp = await fetch('/api/db', { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
            const buf = await resp.arrayBuffer();
            return new Uint8Array(buf);
        }
    } catch (e) {}
    return null;
}

// Save DB to the server file on disk
let lastKnownDbVersion = 0; // Track server DB modification time
let isSaving = false; // Prevent polling during our own save

async function saveDbToServer() {
    if (!serverAvailable || !db) return;
    isSaving = true;
    try {
        const data = db.export();
        await fetch('/api/db', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: data,
            signal: AbortSignal.timeout(3000)
        });
        // Update our known version after saving
        await updateKnownVersion();
    } catch (e) {
        console.warn('Failed to sync DB to server:', e.message);
    }
    isSaving = false;
}

// Get the current DB version (modification timestamp) from server
async function getServerDbVersion() {
    try {
        const resp = await fetch('/api/db/version', { signal: AbortSignal.timeout(2000) });
        if (resp.ok) {
            const json = await resp.json();
            return json.version || 0;
        }
    } catch (e) {}
    return 0;
}

// Update our known version without reloading
async function updateKnownVersion() {
    lastKnownDbVersion = await getServerDbVersion();
}

// Poll for changes from other browser sessions
async function pollForChanges() {
    if (!serverAvailable || isSaving) return;
    try {
        const currentVersion = await getServerDbVersion();
        if (currentVersion > 0 && lastKnownDbVersion > 0 && currentVersion !== lastKnownDbVersion) {
            console.log(`DB changed on server (${lastKnownDbVersion} -> ${currentVersion}). Reloading...`);
            lastKnownDbVersion = currentVersion;
            await reloadDbFromServer();
        }
    } catch (e) {
        // Silently ignore polling errors
    }
}

// Reload the DB from server and refresh all views
async function reloadDbFromServer() {
    const serverData = await loadDbFromServer();
    if (serverData && serverData.length > 0) {
        if (db) db.close();
        db = new SQL.Database(serverData);
        taskIdCounter = null; // Reset counter so it recalculates
        // Refresh all views
        renderTasks();
        renderPlanner();
        restoreTimer();
        updateExportPreview();
        showToast('Data synced from another session', 'info');
    }
}

let pollInterval = null;

function startPolling() {
    if (!serverAvailable) return;
    // Poll every 3 seconds
    pollInterval = setInterval(pollForChanges, 3000);
}

async function initDatabase() {
    SQL = await initSqlJs({ locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}` });

    // Check if local server is running
    const serverStatus = await checkServer();

    // Priority: 1) Server file on disk, 2) IndexedDB cache, 3) New empty DB
    let loaded = false;

    if (serverAvailable) {
        const serverData = await loadDbFromServer();
        if (serverData && serverData.length > 0) {
            db = new SQL.Database(serverData);
            loaded = true;
            console.log('Database loaded from server (disk file)');
        }
    }

    if (!loaded) {
        const savedData = await loadDbFromIndexedDB();
        if (savedData) {
            db = new SQL.Database(new Uint8Array(savedData));
            loaded = true;
            console.log('Database loaded from IndexedDB cache');
        }
    }

    if (!loaded) {
        db = new SQL.Database();
        console.log('New empty database created');
    }

    // Create tables if they don't exist
    db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            name TEXT NOT NULL,
            category TEXT DEFAULT 'Other',
            startDate TEXT,
            startTime TEXT,
            endDate TEXT,
            endTime TEXT,
            notes TEXT,
            status TEXT DEFAULT 'running',
            duration REAL,
            createdAt TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS planner (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            plan_date TEXT NOT NULL,
            name TEXT NOT NULL,
            category TEXT DEFAULT 'Other',
            status TEXT DEFAULT 'pending',
            startTime TEXT,
            endTime TEXT,
            duration REAL,
            notes TEXT,
            createdAt TEXT
        )
    `);

    // Migrate: add task_id column to tasks table if missing
    try {
        db.run(`SELECT task_id FROM tasks LIMIT 1`);
    } catch (e) {
        db.run(`ALTER TABLE tasks ADD COLUMN task_id TEXT DEFAULT ''`);
        // Backfill task_id for existing rows
        const rows = db.exec(`SELECT id FROM tasks WHERE task_id = '' OR task_id IS NULL`);
        if (rows.length > 0) {
            rows[0].values.forEach(row => {
                const tid = generateTaskId();
                db.run(`UPDATE tasks SET task_id = ? WHERE id = ?`, [tid, row[0]]);
            });
        }
    }

    persistDb();
}

// ---------- IndexedDB persistence (auto-save, not file based) ----------
function openIDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('TimeTrackerDB', 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore('db');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function persistDb() {
    if (!db) return;
    const data = db.export();
    // Save to IndexedDB (local browser cache)
    const idb = await openIDB();
    const tx = idb.transaction('db', 'readwrite');
    tx.objectStore('db').put(data, 'main');
    await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
    // Also save to server (disk file) if available
    saveDbToServer();
}

async function loadDbFromIndexedDB() {
    try {
        const idb = await openIDB();
        const tx = idb.transaction('db', 'readonly');
        const req = tx.objectStore('db').get('main');
        return new Promise((resolve) => {
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch {
        return null;
    }
}

// ---------- Helpers ----------
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

let taskIdCounter = null;

function getNextTaskIdNumber() {
    if (taskIdCounter === null) {
        // Find the highest existing task_id number
        let max = 0;
        try {
            const res = db.exec(`SELECT task_id FROM tasks UNION SELECT task_id FROM planner`);
            if (res.length > 0) {
                res[0].values.forEach(row => {
                    const m = String(row[0]).match(/^T(\d+)$/);
                    if (m) {
                        const n = parseInt(m[1], 10);
                        if (n > max) max = n;
                    }
                });
            }
        } catch (e) {}
        taskIdCounter = max;
    }
    taskIdCounter++;
    return taskIdCounter;
}

function generateTaskId() {
    const num = getNextTaskIdNumber();
    return 'T' + String(num).padStart(4, '0');
}

function getTasks() {
    const result = db.exec(`SELECT * FROM tasks ORDER BY createdAt DESC`);
    if (result.length === 0) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        cols.forEach((c, i) => obj[c] = row[i]);
        return obj;
    });
}

function getTaskById(id) {
    const stmt = db.prepare(`SELECT * FROM tasks WHERE id = ?`);
    stmt.bind([id]);
    if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
    }
    stmt.free();
    return null;
}

function saveTasks(tasks) {
    // Not used anymore - kept for compatibility; individual SQL ops instead
}

// ==================== DOM REFERENCES ====================
const navLinks = document.querySelectorAll('.nav-links li');
const tabContents = document.querySelectorAll('.tab-content');
const addTaskBtn = document.getElementById('addTaskBtn');
const taskModal = document.getElementById('taskModal');
const closeModalEl = document.getElementById('closeModal');
const cancelBtn = document.getElementById('cancelBtn');
const taskForm = document.getElementById('taskForm');
const modalTitle = document.getElementById('modalTitle');
const taskListEl = document.getElementById('taskList');
const searchInput = document.getElementById('searchInput');
const filterCategory = document.getElementById('filterCategory');
const filterStatus = document.getElementById('filterStatus');
const filterStartDate = document.getElementById('filterStartDate');
const filterEndDate = document.getElementById('filterEndDate');
const applyDateFilter = document.getElementById('applyDateFilter');
const clearDateFilter = document.getElementById('clearDateFilter');

// Active date filter values (only set when user clicks Filter)
let activeDateFrom = '';
let activeDateTo = '';
const activeTimerSection = document.getElementById('activeTimerSection');
const activeTaskName = document.getElementById('activeTaskName');
const timerDisplay = document.getElementById('timerDisplay');
const stopTimerBtn = document.getElementById('stopTimerBtn');

// Planner
const plannerDate = document.getElementById('plannerDate');
const prevDayBtn = document.getElementById('prevDayBtn');
const nextDayBtn = document.getElementById('nextDayBtn');
const todayBtn = document.getElementById('todayBtn');
const plannerTaskInput = document.getElementById('plannerTaskInput');
const plannerCategoryInput = document.getElementById('plannerCategoryInput');
const addPlannerTaskBtn = document.getElementById('addPlannerTaskBtn');
const plannerList = document.getElementById('plannerList');
const plannerTotal = document.getElementById('plannerTotal');
const plannerCompleted = document.getElementById('plannerCompleted');
const plannerTotalHours = document.getElementById('plannerTotalHours');

// Dashboard
const dashStartDate = document.getElementById('dashStartDate');
const dashEndDate = document.getElementById('dashEndDate');
const applyDashFilter = document.getElementById('applyDashFilter');

// Export
const exportStartDate = document.getElementById('exportStartDate');
const exportEndDate = document.getElementById('exportEndDate');
const exportCategory = document.getElementById('exportCategory');
const exportCount = document.getElementById('exportCount');
const downloadExcelBtn = document.getElementById('downloadExcelBtn');

// DB buttons
const saveDbBtn = document.getElementById('saveDbBtn');
const restoreDbBtn = document.getElementById('restoreDbBtn');
const restoreFileInput = document.getElementById('restoreFileInput');

// Chart instances
let categoryChart = null;
let dailyChart = null;
let statusChart = null;
let topTasksChart = null;

// Timer
let timerInterval = null;
let activeTimerTaskId = null;

// ==================== NAVIGATION ====================
navLinks.forEach(link => {
    link.addEventListener('click', () => {
        const tab = link.dataset.tab;
        navLinks.forEach(l => l.classList.remove('active'));
        link.classList.add('active');
        tabContents.forEach(t => t.classList.remove('active'));
        document.getElementById(tab).classList.add('active');

        if (tab === 'planner') renderPlanner();
        if (tab === 'dashboard') updateDashboard();
        if (tab === 'export') updateExportPreview();
    });
});

// ==================== PLANNER ====================
function initPlanner() {
    const today = formatDateInput(new Date());
    plannerDate.value = today;

    prevDayBtn.addEventListener('click', () => {
        const d = new Date(plannerDate.value);
        d.setDate(d.getDate() - 1);
        plannerDate.value = formatDateInput(d);
        renderPlanner();
    });

    nextDayBtn.addEventListener('click', () => {
        const d = new Date(plannerDate.value);
        d.setDate(d.getDate() + 1);
        plannerDate.value = formatDateInput(d);
        renderPlanner();
    });

    todayBtn.addEventListener('click', () => {
        plannerDate.value = formatDateInput(new Date());
        renderPlanner();
    });

    plannerDate.addEventListener('change', renderPlanner);

    addPlannerTaskBtn.addEventListener('click', addPlannerTask);
    plannerTaskInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addPlannerTask();
    });
}

function addPlannerTask() {
    const name = plannerTaskInput.value.trim();
    if (!name) {
        showToast('Please enter a task name', 'error');
        return;
    }
    const category = plannerCategoryInput.value;
    const date = plannerDate.value;
    const taskId = generateTaskId();

    db.run(
        `INSERT INTO planner (task_id, plan_date, name, category, status, createdAt) VALUES (?, ?, ?, ?, 'pending', ?)`,
        [taskId, date, name, category, new Date().toISOString()]
    );
    persistDb();

    plannerTaskInput.value = '';
    showToast(`Task ${taskId} added to planner`, 'success');
    renderPlanner();
}

function getPlannerTasks(date) {
    const result = db.exec(`SELECT * FROM planner WHERE plan_date = ? ORDER BY id ASC`, [date]);
    if (result.length === 0) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        cols.forEach((c, i) => obj[c] = row[i]);
        return obj;
    });
}

function renderPlanner() {
    const date = plannerDate.value;
    const tasks = getPlannerTasks(date);

    // Update summary
    const completedCount = tasks.filter(t => t.status === 'completed').length;
    const totalHours = tasks.reduce((sum, t) => sum + (t.duration || 0), 0);
    plannerTotal.textContent = `${tasks.length} task${tasks.length !== 1 ? 's' : ''} planned`;
    plannerCompleted.textContent = `${completedCount} completed`;
    plannerTotalHours.textContent = `${formatDuration(totalHours)} tracked`;

    plannerList.innerHTML = '';

    if (tasks.length === 0) {
        plannerList.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-clipboard-list"></i>
                <h3>No tasks planned</h3>
                <p>Add tasks above to plan your day</p>
            </div>
        `;
        return;
    }

    tasks.forEach(task => {
        const item = document.createElement('div');
        const statusClass = task.status === 'completed' ? 'completed' : (task.status === 'running' ? 'running' : '');
        item.className = `planner-item ${statusClass}`;

        // Make clickable for pending/running tasks
        if (task.status === 'pending' || task.status === 'running') {
            item.style.cursor = 'pointer';
        }

        const durText = task.duration ? formatDuration(task.duration) : (task.status === 'running' ? '...' : '—');
        const durLabel = task.status === 'completed' ? 'DONE' : (task.status === 'running' ? 'RUNNING' : 'PENDING');

        item.innerHTML = `
            <span class="planner-item-id">${escapeHtml(task.task_id)}</span>
            <div class="planner-item-main">
                <div class="planner-item-name">${escapeHtml(task.name)}</div>
                <div class="planner-item-meta">
                    <span class="category-badge cat-${task.category}">${task.category}</span>
                    ${task.startTime ? `<span><i class="fas fa-play"></i> ${task.startTime}</span>` : ''}
                    ${task.endTime ? `<span><i class="fas fa-stop"></i> ${task.endTime}</span>` : ''}
                    ${task.notes ? `<span><i class="fas fa-sticky-note"></i> ${escapeHtml(task.notes.substring(0, 30))}</span>` : ''}
                </div>
            </div>
            <div class="planner-item-duration">
                <div class="dur-val">${durText}</div>
                <div class="dur-label">${durLabel}</div>
            </div>
            <div class="planner-item-actions">
                ${task.status === 'pending' ? `
                    <button class="btn-icon success" title="Start Timer" onclick="event.stopPropagation(); startPlannerTask(${task.id})">
                        <i class="fas fa-play"></i>
                    </button>
                ` : ''}
                ${task.status === 'running' ? `
                    <button class="btn-icon" title="Stop Timer" onclick="event.stopPropagation(); stopPlannerTask(${task.id})" style="color: var(--danger);">
                        <i class="fas fa-stop"></i>
                    </button>
                ` : ''}
                ${task.status === 'completed' ? `
                    <button class="btn-icon" title="Completed" disabled style="color: var(--success);">
                        <i class="fas fa-check-circle"></i>
                    </button>
                ` : ''}
                <button class="btn-icon danger" title="Delete" onclick="event.stopPropagation(); deletePlannerTask(${task.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `;

        // Click on the row to start/stop
        if (task.status === 'pending') {
            item.addEventListener('click', () => startPlannerTask(task.id));
        } else if (task.status === 'running') {
            item.addEventListener('click', () => stopPlannerTask(task.id));
        }

        plannerList.appendChild(item);
    });
}

function startPlannerTask(id) {
    const now = new Date();
    const timeStr = formatTimeInput(now);
    db.run(`UPDATE planner SET status = 'running', startTime = ? WHERE id = ?`, [timeStr, id]);
    persistDb();
    showToast('Timer started', 'success');
    renderPlanner();
}

function stopPlannerTask(id) {
    const now = new Date();
    const timeStr = formatTimeInput(now);

    // Get task to calculate duration
    const result = db.exec(`SELECT * FROM planner WHERE id = ?`, [id]);
    if (result.length > 0) {
        const cols = result[0].columns;
        const row = {};
        cols.forEach((c, i) => row[c] = result[0].values[0][i]);

        const planDate = row.plan_date;
        const startTime = row.startTime;
        const duration = calculateDuration(planDate, startTime, planDate, timeStr);

        db.run(`UPDATE planner SET status = 'completed', endTime = ?, duration = ? WHERE id = ?`, [timeStr, duration, id]);
        persistDb();
        showToast(`Task completed — ${formatDuration(duration)}`, 'success');
    }
    renderPlanner();
}

function deletePlannerTask(id) {
    if (!confirm('Delete this planned task?')) return;
    db.run(`DELETE FROM planner WHERE id = ?`, [id]);
    persistDb();
    showToast('Task removed from planner', 'info');
    renderPlanner();
}

window.startPlannerTask = startPlannerTask;
window.stopPlannerTask = stopPlannerTask;
window.deletePlannerTask = deletePlannerTask;

// ==================== MODAL ====================
function openModal(editTask = null) {
    taskModal.classList.add('active');
    if (editTask) {
        modalTitle.textContent = 'Edit Task';
        document.getElementById('taskId').value = editTask.id;
        document.getElementById('taskName').value = editTask.name;
        document.getElementById('taskCategory').value = editTask.category;
        document.getElementById('startDate').value = editTask.startDate;
        document.getElementById('startTime').value = editTask.startTime;
        document.getElementById('endDate').value = editTask.endDate || '';
        document.getElementById('endTime').value = editTask.endTime || '';
        document.getElementById('taskNotes').value = editTask.notes || '';
    } else {
        modalTitle.textContent = 'Add New Task';
        taskForm.reset();
        document.getElementById('taskId').value = '';
        const now = new Date();
        document.getElementById('startDate').value = formatDateInput(now);
        document.getElementById('startTime').value = formatTimeInput(now);
    }
}

function closeModalFn() {
    taskModal.classList.remove('active');
    taskForm.reset();
}

addTaskBtn.addEventListener('click', () => openModal());
closeModalEl.addEventListener('click', closeModalFn);
cancelBtn.addEventListener('click', closeModalFn);
taskModal.addEventListener('click', (e) => {
    if (e.target === taskModal) closeModalFn();
});

// ==================== FORM SUBMISSION ====================
taskForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const id = document.getElementById('taskId').value;
    const name = document.getElementById('taskName').value.trim();
    const category = document.getElementById('taskCategory').value;
    const startDate = document.getElementById('startDate').value;
    const startTime = document.getElementById('startTime').value;
    const endDate = document.getElementById('endDate').value;
    const endTime = document.getElementById('endTime').value;
    const notes = document.getElementById('taskNotes').value.trim();

    if (!name || !startDate || !startTime) {
        showToast('Please fill in required fields', 'error');
        return;
    }

    const isCompleted = endDate && endTime;
    const duration = isCompleted ? calculateDuration(startDate, startTime, endDate, endTime) : null;
    const status = isCompleted ? 'completed' : 'running';

    if (id) {
        // Edit existing
        db.run(
            `UPDATE tasks SET name=?, category=?, startDate=?, startTime=?, endDate=?, endTime=?, notes=?, status=?, duration=? WHERE id=?`,
            [name, category, startDate, startTime, endDate || null, endTime || null, notes || null, status, duration, id]
        );
        if (isCompleted && activeTimerTaskId === id) {
            stopTimer();
        }
        showToast('Task updated successfully', 'success');
    } else {
        const newId = generateId();
        const taskId = generateTaskId();
        db.run(
            `INSERT INTO tasks (id, task_id, name, category, startDate, startTime, endDate, endTime, notes, status, duration, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [newId, taskId, name, category, startDate, startTime, endDate || null, endTime || null, notes || null, status, duration, new Date().toISOString()]
        );
        if (!isCompleted) {
            startTimerFn(newId, name, startDate, startTime);
        }
        showToast(`Task ${taskId} added successfully`, 'success');
    }

    persistDb();
    closeModalFn();
    renderTasks();
});

// ==================== TIMER ====================
function startTimerFn(taskId, taskName, startDate, startTime) {
    if (timerInterval) {
        clearInterval(timerInterval);
    }

    activeTimerTaskId = taskId;
    activeTaskName.textContent = taskName;
    activeTimerSection.style.display = 'block';

    const startDateTime = new Date(`${startDate}T${startTime}`);

    function updateTimer() {
        const now = new Date();
        const diff = now - startDateTime;
        if (diff < 0) {
            timerDisplay.textContent = '00:00:00';
            return;
        }
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        const seconds = Math.floor((diff % 60000) / 1000);
        timerDisplay.textContent =
            String(hours).padStart(2, '0') + ':' +
            String(minutes).padStart(2, '0') + ':' +
            String(seconds).padStart(2, '0');
    }

    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    if (activeTimerTaskId) {
        const task = getTaskById(activeTimerTaskId);
        if (task && task.status === 'running') {
            const now = new Date();
            const endDate = formatDateInput(now);
            const endTime = formatTimeInput(now);
            const duration = calculateDuration(task.startDate, task.startTime, endDate, endTime);
            db.run(
                `UPDATE tasks SET endDate=?, endTime=?, status='completed', duration=? WHERE id=?`,
                [endDate, endTime, duration, activeTimerTaskId]
            );
            persistDb();
            showToast(`Task completed — ${formatDuration(duration)}`, 'success');
        }
    }

    activeTimerTaskId = null;
    activeTimerSection.style.display = 'none';
    timerDisplay.textContent = '00:00:00';
    renderTasks();
}

// Stop a specific task by ID (works for any running task, not just the active timer one)
function stopSpecificTask(taskId) {
    const task = getTaskById(taskId);
    if (!task || task.status !== 'running') return;

    const now = new Date();
    const endDate = formatDateInput(now);
    const endTime = formatTimeInput(now);
    const duration = calculateDuration(task.startDate, task.startTime, endDate, endTime);

    db.run(
        `UPDATE tasks SET endDate=?, endTime=?, status='completed', duration=? WHERE id=?`,
        [endDate, endTime, duration, taskId]
    );
    persistDb();
    showToast(`Task completed — ${formatDuration(duration)}`, 'success');

    // If this was the active timer task, clear the timer display
    if (activeTimerTaskId === taskId) {
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        activeTimerTaskId = null;
        activeTimerSection.style.display = 'none';
        timerDisplay.textContent = '00:00:00';
    }

    // Check if there's another running task to show in the timer
    const tasks = getTasks();
    const nextRunning = tasks.find(t => t.status === 'running');
    if (nextRunning) {
        startTimerFn(nextRunning.id, nextRunning.name, nextRunning.startDate, nextRunning.startTime);
    }

    renderTasks();
}

// Switch the active timer display to show a specific running task
function switchTimerTo(taskId) {
    const task = getTaskById(taskId);
    if (!task || task.status !== 'running') return;
    startTimerFn(task.id, task.name, task.startDate, task.startTime);
}

window.stopSpecificTask = stopSpecificTask;
window.switchTimerTo = switchTimerTo;

stopTimerBtn.addEventListener('click', stopTimer);

function restoreTimer() {
    const tasks = getTasks();
    const runningTask = tasks.find(t => t.status === 'running');
    if (runningTask) {
        startTimerFn(runningTask.id, runningTask.name, runningTask.startDate, runningTask.startTime);
    }
}

// ==================== TASK RENDERING ====================
function renderTasks() {
    const tasks = getTasks();
    const search = searchInput.value.toLowerCase();
    const catFilter = filterCategory.value;
    const statusFilter = filterStatus.value;

    let filtered = tasks.filter(t => {
        const matchSearch = t.name.toLowerCase().includes(search) ||
            (t.notes && t.notes.toLowerCase().includes(search));
        const matchCat = !catFilter || t.category === catFilter;
        const matchStatus = !statusFilter || t.status === statusFilter;

        let matchDateFrom = true;
        let matchDateTo = true;
        if (activeDateFrom && t.startDate) {
            const taskDate = new Date(t.startDate + 'T00:00:00');
            const fromDate = new Date(activeDateFrom + 'T00:00:00');
            matchDateFrom = taskDate >= fromDate;
        }
        if (activeDateTo && t.startDate) {
            const taskDate = new Date(t.startDate + 'T00:00:00');
            const toDate = new Date(activeDateTo + 'T23:59:59');
            matchDateTo = taskDate <= toDate;
        }

        return matchSearch && matchCat && matchStatus && matchDateFrom && matchDateTo;
    });

    taskListEl.innerHTML = '';

    if (filtered.length === 0) {
        taskListEl.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-hourglass-start"></i>
                <h3>No tasks found</h3>
                <p>${tasks.length === 0 ? 'Click "New Task" to start tracking your time' : 'Try adjusting your filters'}</p>
            </div>
        `;
        return;
    }

    filtered.forEach(task => {
        const card = document.createElement('div');
        card.className = `task-card ${task.status}`;

        const durationText = task.status === 'completed' && task.duration !== null
            ? formatDuration(task.duration)
            : 'In Progress';

        const durationLabel = task.status === 'completed' ? 'Duration' : 'Status';

        // Make running tasks clickable
        if (task.status === 'running') {
            card.style.cursor = 'pointer';
        }

        const isActiveTimer = (activeTimerTaskId === task.id);

        card.innerHTML = `
            <span class="task-id-badge">${escapeHtml(task.task_id || '')}</span>
            <div class="task-status-badge ${task.status === 'running' ? 'badge-running' : 'badge-completed'}">
                <i class="fas ${task.status === 'running' ? 'fa-play-circle' : 'fa-check-circle'}"></i>
                ${task.status === 'running' ? 'Running' : 'Done'}
            </div>
            <div class="task-main">
                <div class="task-name">${escapeHtml(task.name)}</div>
                <div class="task-meta">
                    <span class="category-badge cat-${task.category}">${task.category}</span>
                    <span><i class="fas fa-play"></i> ${formatDateTime(task.startDate, task.startTime)}</span>
                    ${task.endDate && task.endTime
                        ? `<span><i class="fas fa-stop"></i> ${formatDateTime(task.endDate, task.endTime)}</span>`
                        : ''}
                    ${task.notes ? `<span><i class="fas fa-sticky-note"></i> ${escapeHtml(task.notes.substring(0, 40))}${task.notes.length > 40 ? '...' : ''}</span>` : ''}
                </div>
            </div>
            <div class="task-duration">
                <div class="duration-value">${durationText}</div>
                <div class="duration-label">${durationLabel}</div>
            </div>
            <div class="task-actions">
                ${task.status === 'running' ? `
                    <button class="btn-icon" title="Stop Timer" onclick="event.stopPropagation(); stopSpecificTask('${task.id}')" style="color: var(--danger);">
                        <i class="fas fa-stop"></i>
                    </button>
                    <button class="btn-icon" title="Show Timer" onclick="event.stopPropagation(); switchTimerTo('${task.id}')" style="color: var(--primary);">
                        <i class="fas fa-clock"></i>
                    </button>
                ` : ''}
                <button class="btn-icon" title="Edit" onclick="event.stopPropagation(); editTask('${task.id}')">
                    <i class="fas fa-pen"></i>
                </button>
                <button class="btn-icon danger" title="Delete" onclick="event.stopPropagation(); deleteTask('${task.id}')">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `;

        // Click on running task row to switch timer to it
        if (task.status === 'running') {
            card.addEventListener('click', () => {
                switchTimerTo(task.id);
            });
        }

        taskListEl.appendChild(card);
    });
}

// ==================== TASK ACTIONS ====================
function editTask(id) {
    const task = getTaskById(id);
    if (task) {
        openModal(task);
    }
}

function deleteTask(id) {
    if (!confirm('Are you sure you want to delete this task?')) return;

    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
    persistDb();

    if (activeTimerTaskId === id) {
        clearInterval(timerInterval);
        timerInterval = null;
        activeTimerTaskId = null;
        activeTimerSection.style.display = 'none';
    }

    showToast('Task deleted', 'info');
    renderTasks();
}

window.editTask = editTask;
window.deleteTask = deleteTask;

// ==================== FILTERS ====================
searchInput.addEventListener('input', renderTasks);
filterCategory.addEventListener('change', renderTasks);
filterStatus.addEventListener('change', renderTasks);

function initDateFilters() {
    const applyBtn = document.getElementById('applyDateFilter');
    const clearBtn = document.getElementById('clearDateFilter');
    const startDateEl = document.getElementById('filterStartDate');
    const endDateEl = document.getElementById('filterEndDate');

    if (applyBtn) {
        applyBtn.addEventListener('click', () => {
            activeDateFrom = startDateEl.value;
            activeDateTo = endDateEl.value;
            console.log('Date filter applied:', activeDateFrom, 'to', activeDateTo);
            if (activeDateFrom || activeDateTo) {
                showToast(`Filtering: ${activeDateFrom || '...'} to ${activeDateTo || '...'}`, 'info');
            }
            renderTasks();
        });
    } else {
        console.error('applyDateFilter button not found!');
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            startDateEl.value = '';
            endDateEl.value = '';
            activeDateFrom = '';
            activeDateTo = '';
            renderTasks();
        });
    }
}

// ==================== SAVE / RESTORE DB ====================
saveDbBtn.addEventListener('click', () => {
    if (!db) return;
    const data = db.export();
    const blob = new Blob([data], { type: 'application/x-sqlite3' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateStr = new Date().toISOString().split('T')[0];
    a.download = `TimeTracker_${dateStr}.sqlite`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Database saved to file', 'success');
});

restoreDbBtn.addEventListener('click', () => {
    restoreFileInput.click();
});

restoreFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
        const arrayBuffer = await file.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuffer);

        // Close existing db
        if (db) db.close();

        db = new SQL.Database(uint8);
        taskIdCounter = null; // Reset counter so it recalculates
        await persistDb();

        showToast('Database restored successfully!', 'success');

        // Refresh all views
        renderTasks();
        renderPlanner();
        restoreTimer();
        updateExportPreview();
    } catch (err) {
        showToast('Failed to restore database: ' + err.message, 'error');
    }

    // Reset file input
    restoreFileInput.value = '';
});

// ==================== DASHBOARD ====================
function updateDashboard() {
    const tasks = getTasks();
    const startFilter = dashStartDate.value;
    const endFilter = dashEndDate.value;

    let filtered = tasks;
    if (startFilter) {
        filtered = filtered.filter(t => t.startDate >= startFilter);
    }
    if (endFilter) {
        filtered = filtered.filter(t => t.startDate <= endFilter);
    }

    const completed = filtered.filter(t => t.status === 'completed');
    const running = filtered.filter(t => t.status === 'running');
    const totalHrs = completed.reduce((sum, t) => sum + (t.duration || 0), 0);
    const avgHrs = completed.length > 0 ? totalHrs / completed.length : 0;

    document.getElementById('totalTasks').textContent = filtered.length;
    document.getElementById('completedTasks').textContent = completed.length;
    document.getElementById('totalHours').textContent = totalHrs.toFixed(1) + 'h';
    document.getElementById('avgHours').textContent = avgHrs.toFixed(1) + 'h';

    // Category Chart
    const catData = {};
    completed.forEach(t => {
        catData[t.category] = (catData[t.category] || 0) + (t.duration || 0);
    });

    if (categoryChart) categoryChart.destroy();
    const catCtx = document.getElementById('categoryChart').getContext('2d');
    categoryChart = new Chart(catCtx, {
        type: 'doughnut',
        data: {
            labels: Object.keys(catData),
            datasets: [{
                data: Object.values(catData).map(v => parseFloat(v.toFixed(2))),
                backgroundColor: ['#4f46e5', '#ec4899', '#f59e0b', '#6366f1', '#10b981', '#8b5cf6', '#64748b'],
                borderWidth: 0, hoverOffset: 8
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true } },
                tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed.toFixed(1)}h` } }
            }
        }
    });

    // Daily Chart
    const dailyData = {};
    completed.forEach(t => {
        dailyData[t.startDate] = (dailyData[t.startDate] || 0) + (t.duration || 0);
    });
    const sortedDays = Object.keys(dailyData).sort();

    if (dailyChart) dailyChart.destroy();
    const dailyCtx = document.getElementById('dailyChart').getContext('2d');
    dailyChart = new Chart(dailyCtx, {
        type: 'bar',
        data: {
            labels: sortedDays.map(d => formatShortDate(d)),
            datasets: [{
                label: 'Hours',
                data: sortedDays.map(d => parseFloat(dailyData[d].toFixed(2))),
                backgroundColor: '#818cf8', borderRadius: 6, barThickness: 32
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y.toFixed(1)} hours` } } },
            scales: {
                y: { beginAtZero: true, title: { display: true, text: 'Hours' }, grid: { color: '#f1f5f9' } },
                x: { grid: { display: false } }
            }
        }
    });

    // Status Chart
    if (statusChart) statusChart.destroy();
    const statusCtx = document.getElementById('statusChart').getContext('2d');
    statusChart = new Chart(statusCtx, {
        type: 'pie',
        data: {
            labels: ['Completed', 'Running'],
            datasets: [{
                data: [completed.length, running.length],
                backgroundColor: ['#10b981', '#4f46e5'], borderWidth: 0, hoverOffset: 8
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true } } }
        }
    });

    // Top Tasks Chart
    const topTasks = [...completed].sort((a, b) => (b.duration || 0) - (a.duration || 0)).slice(0, 8);
    if (topTasksChart) topTasksChart.destroy();
    const topCtx = document.getElementById('topTasksChart').getContext('2d');
    topTasksChart = new Chart(topCtx, {
        type: 'bar',
        data: {
            labels: topTasks.map(t => t.name.length > 25 ? t.name.substring(0, 25) + '...' : t.name),
            datasets: [{
                label: 'Hours',
                data: topTasks.map(t => parseFloat((t.duration || 0).toFixed(2))),
                backgroundColor: '#f59e0b', borderRadius: 6, barThickness: 24
            }]
        },
        options: {
            indexAxis: 'y', responsive: true,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.x.toFixed(1)} hours` } } },
            scales: {
                x: { beginAtZero: true, title: { display: true, text: 'Hours' }, grid: { color: '#f1f5f9' } },
                y: { grid: { display: false } }
            }
        }
    });
}

applyDashFilter.addEventListener('click', updateDashboard);

// ==================== EXPORT ====================
function getFilteredExportTasks() {
    const tasks = getTasks();
    const start = exportStartDate.value;
    const end = exportEndDate.value;
    const cat = exportCategory.value;

    return tasks.filter(t => {
        const matchStart = !start || t.startDate >= start;
        const matchEnd = !end || t.startDate <= end;
        const matchCat = !cat || t.category === cat;
        return matchStart && matchEnd && matchCat;
    });
}

function updateExportPreview() {
    const filtered = getFilteredExportTasks();
    exportCount.textContent = filtered.length;
}

exportStartDate.addEventListener('change', updateExportPreview);
exportEndDate.addEventListener('change', updateExportPreview);
exportCategory.addEventListener('change', updateExportPreview);

downloadExcelBtn.addEventListener('click', () => {
    const filtered = getFilteredExportTasks();

    if (filtered.length === 0) {
        showToast('No tasks to export. Adjust your filters.', 'error');
        return;
    }

    const excelData = filtered.map((t, i) => ({
        'S.No': i + 1,
        'Task ID': t.task_id || '',
        'Task Name': t.name,
        'Category': t.category,
        'Start Date': t.startDate,
        'Start Time': t.startTime,
        'End Date': t.endDate || '',
        'End Time': t.endTime || '',
        'Duration (Hours)': t.duration !== null ? parseFloat(t.duration.toFixed(2)) : 'In Progress',
        'Status': t.status === 'completed' ? 'Completed' : 'Running',
        'Notes': t.notes || ''
    }));

    const completedTasks = filtered.filter(t => t.status === 'completed');
    const totalHours = completedTasks.reduce((sum, t) => sum + (t.duration || 0), 0);

    excelData.push({});
    excelData.push({ 'S.No': '', 'Task ID': '', 'Task Name': 'SUMMARY' });
    excelData.push({ 'S.No': '', 'Task ID': '', 'Task Name': 'Total Tasks', 'Category': filtered.length, 'Start Time': 'Completed', 'End Date': completedTasks.length });
    excelData.push({ 'S.No': '', 'Task ID': '', 'Task Name': 'Total Hours', 'Category': parseFloat(totalHours.toFixed(2)), 'Start Time': 'Avg Hours/Task', 'End Date': completedTasks.length > 0 ? parseFloat((totalHours / completedTasks.length).toFixed(2)) : 0 });

    const ws = XLSX.utils.json_to_sheet(excelData);
    ws['!cols'] = [
        { wch: 6 }, { wch: 10 }, { wch: 30 }, { wch: 16 }, { wch: 12 },
        { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 12 }, { wch: 30 }
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Time Sheet');

    const dateStr = new Date().toISOString().split('T')[0];
    const fileName = `TimeTracker_${dateStr}.xlsx`;
    XLSX.writeFile(wb, fileName);
    showToast(`Downloaded ${fileName}`, 'success');
});

// ==================== UTILITY FUNCTIONS ====================
function calculateDuration(startDate, startTime, endDate, endTime) {
    const start = new Date(`${startDate}T${startTime}`);
    const end = new Date(`${endDate}T${endTime}`);
    const diffMs = end - start;
    if (diffMs < 0) return 0;
    return diffMs / 3600000;
}

function formatDuration(hours) {
    if (hours === null || hours === undefined || hours === 0) return '—';
    if (hours < 1) {
        const mins = Math.round(hours * 60);
        return `${mins}m`;
    }
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}

function formatDateInput(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function formatTimeInput(date) {
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
}

function formatDateTime(date, time) {
    if (!date || !time) return '';
    const d = new Date(`${date}T${time}`);
    return d.toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true
    });
}

function formatShortDate(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
    toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${message}`;
    container.appendChild(toast);
    setTimeout(() => { if (toast.parentElement) toast.remove(); }, 3000);
}

// ==================== SET DEFAULT DATES ====================
function setDefaultDates() {
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const todayStr = formatDateInput(now);
    const pastStr = formatDateInput(thirtyDaysAgo);

    dashStartDate.value = pastStr;
    dashEndDate.value = todayStr;
    exportStartDate.value = pastStr;
    exportEndDate.value = todayStr;
}

// ==================== INIT ====================
async function init() {
    try {
        await initDatabase();
        document.getElementById('loadingOverlay').classList.add('hidden');
        setDefaultDates();
        initDateFilters();
        initPlanner();
        renderPlanner();
        renderTasks();
        restoreTimer();
        updateExportPreview();

        // Set initial DB version and start polling for cross-browser sync
        await updateKnownVersion();
        startPolling();
    } catch (err) {
        console.error('Failed to initialize database:', err);
        document.getElementById('loadingOverlay').innerHTML = `
            <div style="text-align:center; color:#ef4444;">
                <i class="fas fa-exclamation-triangle" style="font-size:48px; margin-bottom:16px;"></i>
                <h3>Failed to load database</h3>
                <p>${err.message}</p>
                <button class="btn btn-primary" onclick="location.reload()" style="margin-top:16px;">Retry</button>
            </div>
        `;
    }
}

document.addEventListener('DOMContentLoaded', init);