import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { GroupDoc, Settings, StatusFilter, TaskDoc, ViewName } from '../types'
import { featureFlags } from '../featureFlags'
import {
  ACTIVE_GROUP_KEY,
  ACTIVE_TASK_KEY,
  GROUPS_PREFIX,
  SETTINGS_KEY,
  TASKS_PREFIX,
  defaultGroups,
  defaultSettings
} from './todoConstants'
import { allDocs, docValue, getStorage, groupPayload, putDoc, removeDoc, setStorage, taskPayload } from './todoPersistence'
import { compactDate, formatDate, formatDateInput, formatTimer, parseDateInputEndOfDay } from './todoFormatters'
import { useTodoDrag } from './useTodoDrag'
import { useTodoKeyboard } from './useTodoKeyboard'
import { useTomatoTimer } from './useTomatoTimer'
import { useTaskSearch } from './useTaskSearch'

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
const deleteGroupId = ref('')
const deleteTaskId = ref('')
const contextMenu = ref<{ open: boolean; x: number; y: number; kind: 'task' | 'group' | ''; id: string }>({
  open: false,
  x: 0,
  y: 0,
  kind: '',
  id: ''
})
const noteEditingTaskId = ref('')
const noteDraft = ref('')
const noteFocused = ref(true)
const tomatoTaskId = ref('')
let mounted = false
let tomatoInterval: number | undefined

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
  syncTomatoSettings()
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
const {
  tomatoRemaining,
  tomatoRunning,
  tomatoProgress,
  tomatoSegments,
  syncTomatoSettings,
  resetTomato,
  toggleTomato,
  updateTomatoMinutes,
  tickTomato
} = useTomatoTimer({
  settings,
  currentTomatoTask,
  saveSettings
})

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

const {
  taskSearchOpen,
  taskSearchQuery,
  taskSearchIndex,
  taskSearchResults,
  openTaskSearch,
  closeTaskSearch,
  updateTaskSearchQuery,
  moveTaskSearchSelection,
  confirmTaskSearchSelection
} = useTaskSearch({
  tasks,
  groupById,
  selectGroup,
  selectTask,
  closeContextMenu
})

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

const {
  dragTaskId,
  dragOverTaskId,
  dragOverTaskGroupId,
  dragInsertPosition,
  dragGroupId,
  dragOverGroupId,
  groupInsertPosition,
  startGroupDrag,
  updateGroupDropTarget,
  clearGroupDropTarget,
  startTaskDrag,
  updateTaskDropTarget,
  clearTaskDropTarget,
  finishTaskDrag,
  onGroupDragDrop,
  onTaskDragDrop
} = useTodoDrag({
  groups,
  tasks,
  activeGroupId,
  activeTaskId,
  editingGroupId,
  editingTaskId,
  visibleTasks,
  taskById,
  allTasksForGroup,
  saveTask,
  saveGroup,
  refreshData,
  selectTask
})

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

function setDueAt(task: TaskDoc, value: string) {
  const updated = { ...task }
  if (value) {
    const dueAt = parseDateInputEndOfDay(value)
    if (!dueAt) return
    updated.dueAt = dueAt
  } else {
    delete updated.dueAt
  }
  saveTask(updated)
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

const { handleKeyboard, handleSettingsEscape } = useTodoKeyboard({
  route,
  settingsOpen,
  groups,
  activeGroupId,
  activeTaskId,
  visibleTasks,
  taskById,
  selectTaskAndReveal,
  selectGroup,
  toggleTask,
  startEditTask,
  requestDeleteTask,
  beginCreateTask,
  openTaskSearch
})

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
    tickTomato()
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
