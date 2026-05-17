import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { GroupDoc, Settings, StatusFilter, TaskDoc, ViewName } from '../types'
import { featureFlags } from '../featureFlags'

const TASKS_PREFIX = 'todo-tasks/'
const GROUPS_PREFIX = 'todo-group/'
const SETTINGS_KEY = 'todo-settings'
const ACTIVE_GROUP_KEY = 'todo-active-group'
const ACTIVE_TASK_KEY = 'todo-active-task'
const LOCAL_DOCS_KEY = 'todo-dev-docs'

interface TaskSearchResult {
  task: TaskDoc
  group: GroupDoc
  score: number
}

export const noteColors = [
  { name: '柔和浅黄', background: '#FFFECF', text: '#000000' },
  { name: '米白黄', background: '#F5F5DC', text: '#000000' },
  { name: '浅灰白', background: '#F0F0F0', text: '#000000' },
  { name: '珍珠白', background: '#FFFAF0', text: '#000000' },
  { name: '浅薄荷绿', background: '#E8F5E9', text: '#000000' },
  { name: '浅天蓝', background: '#E0F7FA', text: '#000000' }
]

const defaultGroups = [
  { _id: `${GROUPS_PREFIX}pending`, title: '待处理', sort: 1 },
  { _id: `${GROUPS_PREFIX}doing`, title: '进行中', sort: 2 },
  { _id: `${GROUPS_PREFIX}unnamed`, title: '未命名', sort: 3 }
]

const defaultSettings: Settings = {
  hideCompleted: false,
  bottomCompleted: false,
  renderMarkdown: false,
  noteBlurTransparent: true,
  noteOpacity: 0.6,
  noteBackground: '#FFFECF',
  tomatoSkin: 'tomato',
  tomatoMinutes: 25,
  tomatoScale: 1
}

const route = ref<ViewName>('main')
const routeQuery = ref(new URLSearchParams())
const groups = ref<GroupDoc[]>([])
const tasks = ref<TaskDoc[]>([])
const settings = reactive<Settings>({ ...defaultSettings })
const activeGroupId = ref(`${GROUPS_PREFIX}pending`)
const activeTaskId = ref('')
const groupComposerOpen = ref(false)
const newGroupTitle = ref('')
const composingTaskGroupId = ref('')
const composingTaskAfterId = ref<string | null>(null)
const composingTaskText = ref('')
const editingTaskId = ref('')
const editingText = ref('')
const editingGroupId = ref('')
const editingGroupTitle = ref('')
const detailTaskId = ref('')
const settingsOpen = ref(false)
const taskSearchOpen = ref(false)
const taskSearchQuery = ref('')
const taskSearchIndex = ref(0)
const deleteGroupId = ref('')
const deleteTaskId = ref('')
const contextMenu = ref<{ open: boolean; x: number; y: number; kind: 'task' | 'group' | ''; id: string }>({
  open: false,
  x: 0,
  y: 0,
  kind: '',
  id: ''
})
const dragTaskId = ref('')
const dragOverTaskId = ref('')
const dragOverTaskGroupId = ref('')
const dragInsertPosition = ref<'before' | 'after' | ''>('')
const dragGroupId = ref('')
const dragOverGroupId = ref('')
const groupInsertPosition = ref<'before' | 'after' | ''>('')
const keyBuffer = ref('')
const noteEditingTaskId = ref('')
const noteDraft = ref('')
const noteFocused = ref(true)
const tomatoTaskId = ref('')
const tomatoRemaining = ref(defaultSettings.tomatoMinutes * 60)
const tomatoRunning = ref(false)
let mounted = false
let tomatoInterval: number | undefined

function hasZtools() {
  return typeof window !== 'undefined' && Boolean((window as any).ztools)
}

function docValue<T>(doc: any): T {
  return (doc?.value || doc) as T
}

function localDocs(): Record<string, any> {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_DOCS_KEY) || '{}')
  } catch {
    return {}
  }
}

function setLocalDocs(docs: Record<string, any>) {
  localStorage.setItem(LOCAL_DOCS_KEY, JSON.stringify(docs))
}

function getStorage<T>(key: string, fallback: T): T {
  if (hasZtools()) return window.ztools.dbStorage.getItem<T>(key) ?? fallback
  try {
    const value = localStorage.getItem(key)
    return value ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}

function setStorage(key: string, value: unknown) {
  if (hasZtools()) window.ztools.dbStorage.setItem(key, value)
  else localStorage.setItem(key, JSON.stringify(value))
}

function allDocs<T>(prefix: string): Array<{ _id: string; value: T }> {
  if (hasZtools()) return window.ztools.db.allDocs<{ value: T }>(prefix) as Array<{ _id: string; value: T }>
  return Object.entries(localDocs())
    .filter(([id]) => id.startsWith(prefix))
    .map(([id, value]) => ({ _id: id, value: value as T }))
}

function putDoc<T>(id: string, value: T) {
  if (hasZtools()) {
    window.ztools.dbStorage.setItem(id, value)
    window.ztools.db.put({ _id: id, value })
    return
  }
  const docs = localDocs()
  docs[id] = value
  setLocalDocs(docs)
}

function removeDoc(id: string) {
  if (hasZtools()) {
    const doc = window.ztools.db.get(id)
    if (doc) window.ztools.db.remove(doc)
    window.ztools.dbStorage.removeItem(id)
    return
  }
  const docs = localDocs()
  delete docs[id]
  setLocalDocs(docs)
}

function taskPayload(task: TaskDoc): Omit<TaskDoc, '_id'> {
  return {
    text: task.text,
    groupId: task.groupId,
    completed: task.completed,
    completed_at: task.completed_at,
    first_completed_at: task.first_completed_at,
    created_at: task.created_at,
    sort: task.sort,
    dueAt: task.dueAt
  }
}

function groupPayload(group: GroupDoc): Omit<GroupDoc, '_id'> {
  return {
    title: group.title,
    sort: group.sort,
    created_at: group.created_at
  }
}

function saveTask(task: TaskDoc, shouldRefresh = true) {
  putDoc(task._id, taskPayload(task))
  if (shouldRefresh) refreshData()
}

function saveGroup(group: GroupDoc, shouldRefresh = true) {
  putDoc(group._id, groupPayload(group))
  if (shouldRefresh) refreshData()
}

function refreshData() {
  const loadedGroups = allDocs<Omit<GroupDoc, '_id'>>(GROUPS_PREFIX)
    .map((doc) => ({ _id: doc._id, ...docValue<Omit<GroupDoc, '_id'>>(doc) }))
    .filter((group) => group.title)
    .sort((a, b) => a.sort - b.sort)

  if (!loadedGroups.length) {
    const now = Date.now()
    defaultGroups.forEach((group, index) => {
      putDoc(group._id, { title: group.title, sort: group.sort, created_at: now + index })
    })
  }

  groups.value = allDocs<Omit<GroupDoc, '_id'>>(GROUPS_PREFIX)
    .map((doc) => ({ _id: doc._id, ...docValue<Omit<GroupDoc, '_id'>>(doc) }))
    .filter((group) => group.title)
    .sort((a, b) => a.sort - b.sort)

  tasks.value = allDocs<Omit<TaskDoc, '_id'>>(TASKS_PREFIX)
    .map((doc) => ({ _id: doc._id, ...docValue<Omit<TaskDoc, '_id'>>(doc) }))
    .filter((task) => task.text && task.groupId)
    .sort((a, b) => a.sort - b.sort)

  if (!groups.value.some((group) => group._id === activeGroupId.value)) {
    activeGroupId.value = groups.value[0]?._id || `${GROUPS_PREFIX}pending`
  }
}

function saveSettings() {
  setStorage(SETTINGS_KEY, { ...settings })
}

function loadSettings() {
  const saved = getStorage<Record<string, unknown>>(SETTINGS_KEY, {})
  const savedSettings: Partial<Settings> = {}
  ;(Object.keys(defaultSettings) as Array<keyof Settings>).forEach((key) => {
    if (saved[key] !== undefined) {
      savedSettings[key] = saved[key] as never
    }
  })
  Object.assign(settings, defaultSettings, savedSettings)
  tomatoRemaining.value = settings.tomatoMinutes * 60
}

function groupById(id: string) {
  return groups.value.find((group) => group._id === id)
}

function taskById(id: string) {
  return tasks.value.find((task) => task._id === id)
}

function allTasksForGroup(groupId: string) {
  return tasks.value
    .filter((task) => task.groupId === groupId)
    .sort((a, b) => a.sort - b.sort)
}

function tasksForGroup(groupId: string, status?: StatusFilter) {
  let result = allTasksForGroup(groupId)
  if (status === 'done') result = result.filter((task) => task.completed)
  if (status === 'pending') result = result.filter((task) => !task.completed)
  if (settings.hideCompleted && !status) result = result.filter((task) => !task.completed)
  return [...result].sort((a, b) => {
    if (settings.bottomCompleted && a.completed !== b.completed) return a.completed ? 1 : -1
    return a.sort - b.sort
  })
}

const activeGroup = computed(() => groupById(activeGroupId.value) || groups.value[0])
const visibleTasks = computed(() => tasksForGroup(activeGroupId.value))
const detailTask = computed(() => taskById(detailTaskId.value))
const deletingTask = computed(() => taskById(deleteTaskId.value))
const contextTask = computed(() => (contextMenu.value.kind === 'task' ? taskById(contextMenu.value.id) : undefined))
const contextGroup = computed(() => (contextMenu.value.kind === 'group' ? groupById(contextMenu.value.id) : undefined))
const currentTomatoTask = computed(() => taskById(tomatoTaskId.value))
const noteGroupName = computed(() => routeQuery.value.get('group') || '待处理')
const noteStatus = computed(() => {
  const status = routeQuery.value.get('status')
  return status === 'done' || status === 'pending' ? status : undefined
})
const noteGroup = computed(() => groups.value.find((group) => group.title === noteGroupName.value) || groups.value[0])
const noteTasks = computed(() => (noteGroup.value ? tasksForGroup(noteGroup.value._id, noteStatus.value) : []))
const pendingCount = computed(() => tasks.value.filter((task) => !task.completed).length)
const taskSearchResults = computed(() => {
  const query = taskSearchQuery.value.trim().toLowerCase()
  const tokens = query.split(/\s+/).filter(Boolean)

  return tasks.value
    .map((task) => {
      const group = groupById(task.groupId)
      if (!group) return null

      const taskText = task.text.toLowerCase()
      const groupTitle = group.title.toLowerCase()
      const haystack = `${taskText}\n${groupTitle}`
      if (tokens.length && !tokens.every((token) => haystack.includes(token))) return null

      let score = 0
      if (!tokens.length) score += 1
      if (query && taskText === query) score += 240
      if (query && taskText.startsWith(query)) score += 180
      if (query && taskText.includes(query)) score += 120
      if (query && groupTitle.includes(query)) score += 40
      if (task.completed) score -= 8

      return { task, group, score }
    })
    .filter((result): result is TaskSearchResult => Boolean(result))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.group.sort !== b.group.sort) return a.group.sort - b.group.sort
      return a.task.sort - b.task.sort
    })
    .slice(0, 12)
})
const tomatoProgress = computed(() => {
  const total = settings.tomatoMinutes * 60
  return total ? 1 - tomatoRemaining.value / total : 0
})
const tomatoSegments = computed(() => Array.from({ length: 25 }, (_, index) => index < Math.ceil(tomatoProgress.value * 25)))

function selectGroup(id: string) {
  activeGroupId.value = id
  setStorage(ACTIVE_GROUP_KEY, id)
  const firstTask = tasksForGroup(id)[0]
  selectTask(firstTask?._id || '')
}

function selectTask(id: string) {
  activeTaskId.value = id
  setStorage(ACTIVE_TASK_KEY, id)
}

function selectTaskAndReveal(id: string) {
  selectTask(id)
  nextTick(() => document.querySelector<HTMLElement>('.task-card.active')?.scrollIntoView({ block: 'nearest' }))
}

function openTaskContextMenu(event: MouseEvent, task: TaskDoc) {
  selectTask(task._id)
  contextMenu.value = {
    open: true,
    x: event.clientX,
    y: event.clientY,
    kind: 'task',
    id: task._id
  }
}

function openGroupContextMenu(event: MouseEvent, group: GroupDoc) {
  contextMenu.value = {
    open: true,
    x: event.clientX,
    y: event.clientY,
    kind: 'group',
    id: group._id
  }
}

function closeContextMenu() {
  contextMenu.value.open = false
}

function openTaskSearch() {
  closeContextMenu()
  taskSearchOpen.value = true
  taskSearchQuery.value = ''
  taskSearchIndex.value = 0
  nextTick(() => document.querySelector<HTMLInputElement>('.task-search-input')?.focus())
}

function closeTaskSearch() {
  taskSearchOpen.value = false
  taskSearchQuery.value = ''
  taskSearchIndex.value = 0
}

function updateTaskSearchQuery(value: string) {
  taskSearchQuery.value = value
  taskSearchIndex.value = 0
}

function moveTaskSearchSelection(delta: number) {
  const count = taskSearchResults.value.length
  if (!count) {
    taskSearchIndex.value = 0
    return
  }
  taskSearchIndex.value = (taskSearchIndex.value + delta + count) % count
}

function confirmTaskSearchSelection(result = taskSearchResults.value[taskSearchIndex.value]) {
  if (!result) return
  const taskId = result.task._id
  closeTaskSearch()
  selectGroup(result.group._id)
  selectTask(taskId)
  nextTick(() => document.querySelector<HTMLElement>('.task-card.active')?.scrollIntoView({ block: 'nearest' }))
}

function createTask(text: string, groupId = activeGroupId.value, afterTaskId: string | null = activeTaskId.value || null) {
  const content = text.trim()
  if (!content) return
  const now = Date.now()
  const task: TaskDoc = {
    _id: `${TASKS_PREFIX}${now}`,
    text: content,
    groupId,
    completed: false,
    created_at: now,
    sort: now
  }

  const ordered = allTasksForGroup(groupId).filter((item) => item._id !== task._id)
  const afterIndex = afterTaskId ? ordered.findIndex((item) => item._id === afterTaskId) : -1
  ordered.splice(afterIndex >= 0 ? afterIndex + 1 : 0, 0, task)
  ordered.forEach((item, index) => saveTask({ ...item, groupId, sort: index + 1 }, false))
  refreshData()
  selectGroup(groupId)
  selectTask(task._id)
}

function beginCreateTask(groupId = activeGroupId.value, afterTaskId: string | null = activeTaskId.value || null) {
  composingTaskGroupId.value = groupId
  composingTaskAfterId.value = afterTaskId && taskById(afterTaskId)?.groupId === groupId ? afterTaskId : null
  composingTaskText.value = ''
  if (activeGroupId.value !== groupId) selectGroup(groupId)
  nextTick(() => document.querySelector<HTMLTextAreaElement>('.task-create-input')?.focus())
}

function saveComposedTask(groupId = composingTaskGroupId.value) {
  if (!composingTaskText.value.trim()) {
    cancelComposedTask()
    return
  }
  createTask(composingTaskText.value, groupId, composingTaskAfterId.value)
  cancelComposedTask()
}

function cancelComposedTask() {
  composingTaskGroupId.value = ''
  composingTaskAfterId.value = null
  composingTaskText.value = ''
}

function showGroupComposer() {
  groupComposerOpen.value = true
  nextTick(() => document.querySelector<HTMLInputElement>('.group-create-input')?.focus())
}

function createGroup(title = newGroupTitle.value) {
  const name = title.trim()
  if (!name) {
    groupComposerOpen.value = false
    return
  }
  const now = Date.now()
  const group: GroupDoc = {
    _id: `${GROUPS_PREFIX}${now}`,
    title: name,
    sort: groups.value.reduce((max, item) => Math.max(max, item.sort), 0) + 1,
    created_at: now
  }
  saveGroup(group)
  newGroupTitle.value = ''
  groupComposerOpen.value = false
  selectGroup(group._id)
}

function startGroupEdit(group: GroupDoc) {
  editingGroupId.value = group._id
  editingGroupTitle.value = group.title
}

function renameGroup(group: GroupDoc) {
  const title = editingGroupTitle.value.trim()
  if (!title) return
  saveGroup({ ...group, title })
  editingGroupId.value = ''
}

function deleteGroup(group: GroupDoc) {
  tasks.value.filter((task) => task.groupId === group._id).forEach((task) => removeDoc(task._id))
  removeDoc(group._id)
  deleteGroupId.value = ''
  refreshData()
  selectGroup(groups.value[0]?._id || `${GROUPS_PREFIX}pending`)
}

function toggleTask(task: TaskDoc) {
  const now = Date.now()
  const updated = { ...task, completed: !task.completed }
  if (updated.completed) {
    updated.completed_at = now
    if (!updated.first_completed_at) updated.first_completed_at = now
  } else {
    delete updated.completed_at
  }
  saveTask(updated)
}

function startEditTask(task: TaskDoc) {
  editingTaskId.value = task._id
  editingText.value = task.text
  nextTick(() => document.querySelector<HTMLTextAreaElement>('.task-edit-input')?.focus())
}

function saveEditTask(task: TaskDoc) {
  const text = editingText.value.trim()
  if (!text) return
  saveTask({ ...task, text })
  editingTaskId.value = ''
}

function requestDeleteTask(task: TaskDoc) {
  deleteTaskId.value = task._id
}

function confirmDeleteTask() {
  const task = deletingTask.value
  if (!task) {
    deleteTaskId.value = ''
    return
  }
  removeDoc(task._id)
  deleteTaskId.value = ''
  refreshData()
  if (activeTaskId.value === task._id) activeTaskId.value = visibleTasks.value[0]?._id || ''
}

function moveTask(task: TaskDoc, position: 'top' | 'bottom') {
  const sorted = allTasksForGroup(task.groupId).filter((item) => item._id !== task._id)
  if (position === 'top') sorted.unshift(task)
  else sorted.push(task)
  sorted.forEach((item, index) => saveTask({ ...item, sort: index + 1 }, false))
  refreshData()
}

function startGroupDrag(group: GroupDoc) {
  if (editingGroupId.value === group._id) {
    clearGroupDropTarget()
    return
  }
  dragGroupId.value = group._id
}

function updateGroupDropTarget(event: DragEvent, group: GroupDoc) {
  if (dragTaskId.value) {
    const task = taskById(dragTaskId.value)
    if (!task || task.groupId === group._id) {
      clearGroupDropTarget()
      return
    }
    event.dataTransfer!.dropEffect = 'move'
    clearGroupDropTarget()
    clearTaskDropTarget()
    dragOverTaskGroupId.value = group._id
    return
  }
  if (!dragGroupId.value || dragGroupId.value === group._id) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  dragOverGroupId.value = group._id
  groupInsertPosition.value = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

function clearGroupDropTarget() {
  dragOverGroupId.value = ''
  groupInsertPosition.value = ''
  dragOverTaskGroupId.value = ''
}

function onGroupDragDrop(target: GroupDoc, position = groupInsertPosition.value) {
  if (dragTaskId.value) {
    onTaskGroupDrop(target)
    return
  }
  const sourceId = dragGroupId.value
  dragGroupId.value = ''
  const resolvedPosition = position || 'before'
  clearGroupDropTarget()
  if (!sourceId || sourceId === target._id) return
  const ordered = [...groups.value]
  const sourceIndex = ordered.findIndex((group) => group._id === sourceId)
  if (sourceIndex < 0) return
  const [source] = ordered.splice(sourceIndex, 1)
  const targetIndex = ordered.findIndex((group) => group._id === target._id)
  if (targetIndex < 0) return
  const insertIndex = resolvedPosition === 'after' ? targetIndex + 1 : targetIndex
  ordered.splice(insertIndex, 0, source)
  ordered.forEach((group, index) => saveGroup({ ...group, sort: index + 1 }, false))
  refreshData()
}

function startTaskDrag(task: TaskDoc) {
  if (editingTaskId.value === task._id) {
    clearTaskDropTarget()
    return
  }
  dragTaskId.value = task._id
}

function updateTaskDropTarget(event: DragEvent, task: TaskDoc) {
  if (!dragTaskId.value || dragTaskId.value === task._id) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  dragOverTaskGroupId.value = ''
  dragOverTaskId.value = task._id
  dragInsertPosition.value = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

function clearTaskDropTarget() {
  dragOverTaskId.value = ''
  dragOverTaskGroupId.value = ''
  dragInsertPosition.value = ''
}

function finishTaskDrag() {
  dragTaskId.value = ''
  clearTaskDropTarget()
}

function onTaskDragDrop(targetTask?: TaskDoc, position = dragInsertPosition.value) {
  const sourceId = dragTaskId.value
  dragTaskId.value = ''
  const resolvedPosition = position || 'before'
  clearTaskDropTarget()
  const source = taskById(sourceId)
  if (!source) return
  const ordered = allTasksForGroup(activeGroupId.value).filter((task) => task._id !== source._id)
  const targetIndex = targetTask ? ordered.findIndex((task) => task._id === targetTask._id) : ordered.length
  const insertIndex = targetTask && targetIndex >= 0 && resolvedPosition === 'after' ? targetIndex + 1 : targetIndex
  ordered.splice(insertIndex < 0 ? ordered.length : insertIndex, 0, { ...source, groupId: activeGroupId.value })
  ordered.forEach((task, index) => saveTask({ ...task, sort: index + 1, groupId: activeGroupId.value }, false))
  refreshData()
  selectTask(sourceId)
}

function onTaskGroupDrop(targetGroup: GroupDoc) {
  const sourceId = dragTaskId.value
  dragTaskId.value = ''
  clearTaskDropTarget()
  clearGroupDropTarget()
  const source = taskById(sourceId)
  if (!source || source.groupId === targetGroup._id) return

  const ordered = tasks.value
    .filter((task) => task.groupId === targetGroup._id && task._id !== source._id)
    .sort((a, b) => a.sort - b.sort)
  ordered.push({ ...source, groupId: targetGroup._id })
  ordered.forEach((task, index) => saveTask({ ...task, groupId: targetGroup._id, sort: index + 1 }, false))
  refreshData()
  if (activeTaskId.value === sourceId) activeTaskId.value = visibleTasks.value[0]?._id || ''
}

function openNote(group = activeGroup.value) {
  if (!featureFlags.noteWindow) return
  if (!group) return
  window.services?.openNote({ group: group.title })
}

function openTomato(task = taskById(activeTaskId.value)) {
  if (!featureFlags.tomatoWindow) return
  window.services?.openTomato(task?._id)
}

function createNoteTask() {
  if (!noteGroup.value) return
  createTask(noteDraft.value, noteGroup.value._id, null)
  noteDraft.value = ''
}

function formatDateInput(timestamp?: number) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function setDueAt(task: TaskDoc, value: string) {
  const updated = { ...task }
  if (value) {
    const [year, month, day] = value.split('-').map(Number)
    if (!year || !month || !day) return
    updated.dueAt = new Date(year, month - 1, day, 23, 59, 59, 999).getTime()
  } else {
    delete updated.dueAt
  }
  saveTask(updated)
}

function formatDate(timestamp?: number) {
  if (!timestamp) return '-'
  return new Date(timestamp).toLocaleString()
}

function compactDate(timestamp?: number) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function resetTomato() {
  tomatoRunning.value = false
  tomatoRemaining.value = settings.tomatoMinutes * 60
}

function toggleTomato() {
  tomatoRunning.value = !tomatoRunning.value
}

function completeTomato() {
  tomatoRunning.value = false
  tomatoRemaining.value = 0
  window.ztools?.showNotification?.('番茄钟已完成')
  if (currentTomatoTask.value) {
    const history = getStorage<any[]>('todo-tomato-history', [])
    history.push({
      taskId: currentTomatoTask.value._id,
      text: currentTomatoTask.value.text,
      minutes: settings.tomatoMinutes,
      completed_at: Date.now()
    })
    setStorage('todo-tomato-history', history)
  }
}

function updateTomatoMinutes(minutes: number) {
  if (tomatoRunning.value) return
  settings.tomatoMinutes = Math.min(60, Math.max(5, minutes))
  tomatoRemaining.value = settings.tomatoMinutes * 60
  saveSettings()
}

function formatTimer(seconds: number) {
  const minute = Math.floor(seconds / 60)
  const second = seconds % 60
  return `${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
}

function closeCurrentWindow() {
  window.services?.closeWindow?.()
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '')
  const [name, query = ''] = raw.split('?')
  if (name === 'note' && featureFlags.noteWindow) route.value = name
  else if (name === 'tomato' && featureFlags.tomatoWindow) route.value = name
  else route.value = 'main'
  routeQuery.value = new URLSearchParams(query)
  tomatoTaskId.value = routeQuery.value.get('taskId') || activeTaskId.value
}

function handlePluginEnter(action: { code: string; type: string; payload: any }) {
  if (action.code === 'new-note') {
    if (featureFlags.noteWindow) window.services?.openNote()
    window.ztools?.outPlugin?.()
    return
  }
  route.value = 'main'
  if (action.code === 'add') {
    const text = Array.isArray(action.payload) ? action.payload.join('\n') : String(action.payload || '')
    createTask(text, activeGroupId.value, activeTaskId.value || null)
    window.ztools?.showNotification?.('已添加到待办')
    return
  }
  refreshData()
}

function handleKeyboard(event: KeyboardEvent) {
  const target = event.target as HTMLElement
  if (route.value !== 'main') return

  if (settingsOpen.value) {
    if (event.key === 'j' || event.key === 'k') {
      event.preventDefault()
      const content = document.querySelector<HTMLElement>('.settings-content')
      content?.scrollBy({ top: event.key === 'j' ? 72 : -72, behavior: 'smooth' })
      return
    }
  }

  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

  const taskList = visibleTasks.value
  const taskIndex = taskList.findIndex((task) => task._id === activeTaskId.value)
  const groupIndex = groups.value.findIndex((group) => group._id === activeGroupId.value)
  const activeTask = taskById(activeTaskId.value)

  if (event.key === '?') {
    event.preventDefault()
    settingsOpen.value = true
    return
  }

  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    openTaskSearch()
    return
  }

  if (event.ctrlKey && event.key.toLowerCase() === 'n') {
    event.preventDefault()
    beginCreateTask(activeGroupId.value, activeTaskId.value || null)
    return
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    beginCreateTask(activeGroupId.value, activeTaskId.value || null)
    return
  }
  if (event.key === 'j' || event.key === 'ArrowDown') {
    event.preventDefault()
    const nextIndex = taskIndex >= 0 ? (taskIndex + 1) % taskList.length : 0
    const next = taskList[nextIndex]
    if (next) selectTaskAndReveal(next._id)
  } else if (event.key === 'k' || event.key === 'ArrowUp') {
    event.preventDefault()
    const prevIndex = taskIndex >= 0 ? (taskIndex - 1 + taskList.length) % taskList.length : taskList.length - 1
    const prev = taskList[prevIndex]
    if (prev) selectTaskAndReveal(prev._id)
  } else if (event.key === 'h' || event.key === 'ArrowLeft') {
    event.preventDefault()
    const groupCount = groups.value.length
    const prevIndex = groupIndex >= 0 ? (groupIndex - 1 + groupCount) % groupCount : groupCount - 1
    const group = groups.value[prevIndex]
    if (group) selectGroup(group._id)
  } else if (event.key === 'l' || event.key === 'ArrowRight') {
    event.preventDefault()
    const groupCount = groups.value.length
    const nextIndex = groupIndex >= 0 ? (groupIndex + 1) % groupCount : 0
    const group = groups.value[nextIndex]
    if (group) selectGroup(group._id)
  } else if ((event.key === ' ' || event.key === 'Spacebar') && activeTask) {
    event.preventDefault()
    toggleTask(activeTask)
  } else if ((event.key === 'Enter' || event.key === 'i') && activeTask) {
    event.preventDefault()
    startEditTask(activeTask)
  } else if ((event.key === 'Backspace' || event.key === 'Delete') && activeTask) {
    event.preventDefault()
    requestDeleteTask(activeTask)
  } else if (event.key === 'G') {
    event.preventDefault()
    const lastTask = taskList[taskList.length - 1]
    if (lastTask) selectTaskAndReveal(lastTask._id)
  } else if (event.key === 'g') {
    keyBuffer.value += 'g'
    if (keyBuffer.value.endsWith('gg')) {
      event.preventDefault()
      const firstTask = taskList[0]
      if (firstTask) selectTaskAndReveal(firstTask._id)
      keyBuffer.value = ''
    }
  } else if (event.key === 'd') {
    keyBuffer.value += 'd'
    if (keyBuffer.value.endsWith('dd') && activeTask) {
      event.preventDefault()
      requestDeleteTask(activeTask)
      keyBuffer.value = ''
    }
  } else {
    keyBuffer.value = ''
  }
}

function handleSettingsEscape(event: KeyboardEvent) {
  if (route.value !== 'main' || !settingsOpen.value || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
  settingsOpen.value = false
}

function mountStore() {
  if (mounted) return
  mounted = true
  loadSettings()
  activeGroupId.value = getStorage(ACTIVE_GROUP_KEY, activeGroupId.value)
  activeTaskId.value = getStorage(ACTIVE_TASK_KEY, '')
  refreshData()
  parseRoute()
  window.addEventListener('hashchange', parseRoute)
  window.addEventListener('keydown', handleSettingsEscape, { capture: true })
  window.addEventListener('keydown', handleKeyboard)
  window.ztools?.onPluginEnter?.(handlePluginEnter)
  window.ztools?.onDbPull?.(() => refreshData())
  tomatoInterval = window.setInterval(() => {
    if (!tomatoRunning.value) return
    if (tomatoRemaining.value <= 1) completeTomato()
    else tomatoRemaining.value -= 1
  }, 1000)
}

function unmountStore() {
  window.removeEventListener('hashchange', parseRoute)
  window.removeEventListener('keydown', handleSettingsEscape, { capture: true })
  window.removeEventListener('keydown', handleKeyboard)
  if (tomatoInterval) window.clearInterval(tomatoInterval)
  mounted = false
}

export function useTodoStore() {
  onMounted(mountStore)
  onBeforeUnmount(unmountStore)

  return {
    route,
    groups,
    tasks,
    settings,
    activeGroupId,
    activeTaskId,
    groupComposerOpen,
    newGroupTitle,
    composingTaskGroupId,
    composingTaskAfterId,
    composingTaskText,
    editingTaskId,
    editingText,
    editingGroupId,
    editingGroupTitle,
    detailTaskId,
    deletingTask,
    settingsOpen,
    taskSearchOpen,
    taskSearchQuery,
    taskSearchIndex,
    deleteGroupId,
    deleteTaskId,
    contextMenu,
    dragTaskId,
    dragOverTaskId,
    dragOverTaskGroupId,
    dragInsertPosition,
    dragGroupId,
    dragOverGroupId,
    groupInsertPosition,
    noteEditingTaskId,
    noteDraft,
    noteFocused,
    tomatoTaskId,
    tomatoRemaining,
    tomatoRunning,
    activeGroup,
    visibleTasks,
    detailTask,
    currentTomatoTask,
    contextTask,
    contextGroup,
    noteGroupName,
    noteTasks,
    pendingCount,
    taskSearchResults,
    tomatoProgress,
    tomatoSegments,
    saveSettings,
    refreshData,
    groupById,
    taskById,
    tasksForGroup,
    selectGroup,
    selectTask,
    openTaskContextMenu,
    openGroupContextMenu,
    closeContextMenu,
    openTaskSearch,
    closeTaskSearch,
    updateTaskSearchQuery,
    moveTaskSearchSelection,
    confirmTaskSearchSelection,
    beginCreateTask,
    saveComposedTask,
    cancelComposedTask,
    showGroupComposer,
    createGroup,
    startGroupEdit,
    renameGroup,
    deleteGroup,
    toggleTask,
    startEditTask,
    saveEditTask,
    requestDeleteTask,
    confirmDeleteTask,
    moveTask,
    startGroupDrag,
    updateGroupDropTarget,
    clearGroupDropTarget,
    startTaskDrag,
    updateTaskDropTarget,
    clearTaskDropTarget,
    finishTaskDrag,
    onGroupDragDrop,
    onTaskDragDrop,
    openNote,
    openTomato,
    createNoteTask,
    formatDateInput,
    setDueAt,
    formatDate,
    compactDate,
    resetTomato,
    toggleTomato,
    updateTomatoMinutes,
    formatTimer,
    closeCurrentWindow
  }
}
