/**
 * Task Queue with Priority - Manages concurrent agent tasks
 *
 * Features:
 * - Priority-based task ordering (lower number = higher priority)
 * - Configurable concurrency limit
 * - Task cancellation
 * - Event emission for progress tracking
 *
 * @module services/task-queue
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';

/**
 * Task status constants
 */
export const TaskStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/**
 * Priority levels (lower = higher priority)
 */
export const Priority = {
  URGENT: 1,
  HIGH: 3,
  NORMAL: 5,
  LOW: 7,
  BACKGROUND: 9,
};

/**
 * Task Queue with priority-based processing
 *
 * Events:
 * - 'task:queued' - { taskId, priority }
 * - 'task:started' - { taskId }
 * - 'task:completed' - { taskId, result }
 * - 'task:failed' - { taskId, error }
 * - 'task:cancelled' - { taskId }
 * - 'queue:empty' - {}
 */
export class TaskQueue extends EventEmitter {
  /**
   * @param {Object} options Configuration options
   * @param {number} [options.maxConcurrent=3] Maximum concurrent tasks
   * @param {number} [options.defaultPriority=5] Default priority for new tasks
   * @param {boolean} [options.autoStart=true] Start processing immediately
   */
  constructor(options = {}) {
    super();
    this.maxConcurrent = options.maxConcurrent || 3;
    this.defaultPriority = options.defaultPriority || Priority.NORMAL;
    this.autoStart = options.autoStart !== false;

    /** @type {Map<string, QueuedTask>} */
    this.tasks = new Map();

    /** @type {string[]} */
    this.queue = []; // Task IDs in priority order

    /** @type {Set<string>} */
    this.running = new Set(); // Currently running task IDs

    this.paused = false;
  }

  /**
   * Add a task to the queue
   * @param {Function} taskFn - Async function to execute
   * @param {Object} [options] - Task options
   * @param {number} [options.priority] - Task priority (lower = higher priority)
   * @param {string} [options.description] - Human-readable description
   * @param {Object} [options.metadata] - Additional metadata
   * @returns {Promise<any>} Promise that resolves with task result
   */
  enqueue(taskFn, options = {}) {
    const taskId = crypto.randomUUID();
    const priority = options.priority ?? this.defaultPriority;

    const task = {
      id: taskId,
      fn: taskFn,
      priority,
      status: TaskStatus.QUEUED,
      description: options.description || '',
      metadata: options.metadata || {},
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
    };

    // Create promise for caller to await
    const promise = new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
    });

    this.tasks.set(taskId, task);

    // Insert into queue in priority order
    this.insertByPriority(taskId, priority);

    this.emit('task:queued', { taskId, priority, description: task.description });

    // Start processing if auto-start is enabled
    if (this.autoStart && !this.paused) {
      this.processNext();
    }

    return promise;
  }

  /**
   * Insert task ID into queue maintaining priority order
   * @param {string} taskId - Task ID to insert
   * @param {number} priority - Task priority
   */
  insertByPriority(taskId, priority) {
    // Find insertion point (first task with lower priority)
    let insertIndex = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      const existingTask = this.tasks.get(this.queue[i]);
      if (existingTask && existingTask.priority > priority) {
        insertIndex = i;
        break;
      }
    }
    this.queue.splice(insertIndex, 0, taskId);
  }

  /**
   * Process next task in queue if capacity available
   */
  async processNext() {
    if (this.paused) return;
    if (this.running.size >= this.maxConcurrent) return;
    if (this.queue.length === 0) {
      if (this.running.size === 0) {
        this.emit('queue:empty', {});
      }
      return;
    }

    // Get next task
    const taskId = this.queue.shift();
    const task = this.tasks.get(taskId);

    if (!task || task.status !== TaskStatus.QUEUED) {
      // Task was cancelled or removed
      this.processNext();
      return;
    }

    // Start task
    task.status = TaskStatus.RUNNING;
    task.startedAt = Date.now();
    this.running.add(taskId);

    this.emit('task:started', { taskId, description: task.description });

    try {
      // Execute task
      task.result = await task.fn();
      task.status = TaskStatus.COMPLETED;
      task.completedAt = Date.now();

      this.emit('task:completed', { taskId, result: task.result });
      task.resolve(task.result);
    } catch (err) {
      task.status = TaskStatus.FAILED;
      task.error = err.message;
      task.completedAt = Date.now();

      this.emit('task:failed', { taskId, error: err.message });
      task.reject(err);
    } finally {
      this.running.delete(taskId);
      // Process next task
      this.processNext();
    }
  }

  /**
   * Cancel a queued task
   * @param {string} taskId - Task ID to cancel
   * @returns {boolean} True if task was cancelled
   */
  cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === TaskStatus.QUEUED) {
      task.status = TaskStatus.CANCELLED;
      task.completedAt = Date.now();

      // Remove from queue
      const index = this.queue.indexOf(taskId);
      if (index !== -1) {
        this.queue.splice(index, 1);
      }

      this.emit('task:cancelled', { taskId });
      task.reject(new Error('Task cancelled'));
      return true;
    }

    // Cannot cancel running or completed tasks
    return false;
  }

  /**
   * Get task status
   * @param {string} taskId - Task ID
   * @returns {Object|null} Task info or null if not found
   */
  getTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    return {
      id: task.id,
      status: task.status,
      priority: task.priority,
      description: task.description,
      metadata: task.metadata,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      duration: task.completedAt
        ? task.completedAt - (task.startedAt || task.createdAt)
        : task.startedAt
          ? Date.now() - task.startedAt
          : null,
      error: task.error,
    };
  }

  /**
   * Pause queue processing
   */
  pause() {
    this.paused = true;
  }

  /**
   * Resume queue processing
   */
  resume() {
    this.paused = false;
    // Process pending tasks
    for (let i = 0; i < this.maxConcurrent - this.running.size; i++) {
      this.processNext();
    }
  }

  /**
   * Get queue statistics
   * @returns {Object} Queue stats
   */
  getStats() {
    const byStatus = {
      [TaskStatus.QUEUED]: 0,
      [TaskStatus.RUNNING]: 0,
      [TaskStatus.COMPLETED]: 0,
      [TaskStatus.FAILED]: 0,
      [TaskStatus.CANCELLED]: 0,
    };

    for (const task of this.tasks.values()) {
      byStatus[task.status]++;
    }

    return {
      total: this.tasks.size,
      queued: byStatus[TaskStatus.QUEUED],
      running: byStatus[TaskStatus.RUNNING],
      completed: byStatus[TaskStatus.COMPLETED],
      failed: byStatus[TaskStatus.FAILED],
      cancelled: byStatus[TaskStatus.CANCELLED],
      maxConcurrent: this.maxConcurrent,
      paused: this.paused,
    };
  }

  /**
   * List all tasks
   * @param {Object} [filter] - Filter options
   * @param {string} [filter.status] - Filter by status
   * @returns {Object[]} Array of task info
   */
  listTasks(filter = {}) {
    const tasks = [];
    for (const task of this.tasks.values()) {
      if (filter.status && task.status !== filter.status) continue;
      tasks.push(this.getTask(task.id));
    }
    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Clear completed/failed/cancelled tasks
   * @returns {number} Number of tasks cleared
   */
  clearCompleted() {
    let count = 0;
    for (const [taskId, task] of this.tasks.entries()) {
      if (
        task.status === TaskStatus.COMPLETED ||
        task.status === TaskStatus.FAILED ||
        task.status === TaskStatus.CANCELLED
      ) {
        this.tasks.delete(taskId);
        count++;
      }
    }
    return count;
  }

  /**
   * Destroy the queue
   */
  destroy() {
    this.pause();
    // Cancel all queued tasks
    for (const taskId of [...this.queue]) {
      this.cancel(taskId);
    }
    this.tasks.clear();
    this.queue = [];
    this.removeAllListeners();
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton TaskQueue instance
 * @param {Object} [config] - Configuration (only used on first call)
 * @returns {TaskQueue}
 */
export function getTaskQueue(config) {
  if (!instance) {
    instance = new TaskQueue(config);
  }
  return instance;
}

/**
 * Reset the singleton (mainly for testing)
 */
export function resetTaskQueue() {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}

export default TaskQueue;
