import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  TaskQueue,
  TaskStatus,
  Priority,
  getTaskQueue,
  resetTaskQueue,
} from '../src/services/task-queue.js';

describe('TaskQueue', () => {
  let queue;

  beforeEach(() => {
    queue = new TaskQueue({ maxConcurrent: 2, autoStart: true });
  });

  afterEach(() => {
    queue.destroy();
  });

  describe('constructor', () => {
    it('should use default values when no options provided', () => {
      const defaultQueue = new TaskQueue();
      const stats = defaultQueue.getStats();
      assert.strictEqual(stats.maxConcurrent, 3);
      assert.strictEqual(stats.paused, false);
      defaultQueue.destroy();
    });

    it('should use provided options', () => {
      const stats = queue.getStats();
      assert.strictEqual(stats.maxConcurrent, 2);
    });
  });

  describe('enqueue', () => {
    it('should add task to queue and return promise', async () => {
      const result = await queue.enqueue(() => Promise.resolve('success'));
      assert.strictEqual(result, 'success');
    });

    it('should process tasks in priority order', async () => {
      const order = [];
      const pausedQueue = new TaskQueue({ maxConcurrent: 1, autoStart: false });

      pausedQueue.enqueue(() => { order.push('low'); return Promise.resolve(); }, { priority: Priority.LOW });
      pausedQueue.enqueue(() => { order.push('urgent'); return Promise.resolve(); }, { priority: Priority.URGENT });
      pausedQueue.enqueue(() => { order.push('high'); return Promise.resolve(); }, { priority: Priority.HIGH });

      pausedQueue.resume();

      // Wait for all tasks to complete
      await new Promise(r => setTimeout(r, 100));

      assert.deepStrictEqual(order, ['urgent', 'high', 'low']);
      pausedQueue.destroy();
    });

    it('should respect maxConcurrent limit', async () => {
      let running = 0;
      let maxRunning = 0;

      const tasks = Array.from({ length: 5 }, () =>
        queue.enqueue(async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise(r => setTimeout(r, 50));
          running--;
        })
      );

      await Promise.all(tasks);

      assert.ok(maxRunning <= 2, `Max concurrent was ${maxRunning}, expected <= 2`);
    });

    it('should emit task:queued event', async () => {
      let emittedEvent = null;
      queue.on('task:queued', (event) => { emittedEvent = event; });

      queue.enqueue(() => Promise.resolve(), { priority: Priority.HIGH, description: 'test task' });

      assert.ok(emittedEvent);
      assert.strictEqual(emittedEvent.priority, Priority.HIGH);
      assert.strictEqual(emittedEvent.description, 'test task');
    });
  });

  describe('task lifecycle events', () => {
    it('should emit task:started and task:completed events', async () => {
      const events = [];
      queue.on('task:started', (e) => events.push({ type: 'started', ...e }));
      queue.on('task:completed', (e) => events.push({ type: 'completed', ...e }));

      await queue.enqueue(() => Promise.resolve('done'));

      assert.strictEqual(events.length, 2);
      assert.strictEqual(events[0].type, 'started');
      assert.strictEqual(events[1].type, 'completed');
      assert.strictEqual(events[1].result, 'done');
    });

    it('should emit task:failed event on error', async () => {
      let failedEvent = null;
      queue.on('task:failed', (e) => { failedEvent = e; });

      try {
        await queue.enqueue(() => Promise.reject(new Error('test error')));
      } catch {
        // Expected
      }

      assert.ok(failedEvent);
      assert.strictEqual(failedEvent.error, 'test error');
    });

    it('should emit queue:empty when all tasks complete', async () => {
      let emptyEmitted = false;
      queue.on('queue:empty', () => { emptyEmitted = true; });

      await queue.enqueue(() => Promise.resolve());

      // Wait a tick for the event
      await new Promise(r => setTimeout(r, 10));
      assert.ok(emptyEmitted);
    });
  });

  describe('cancel', () => {
    it('should cancel queued task', async () => {
      const pausedQueue = new TaskQueue({ maxConcurrent: 1, autoStart: false });
      let taskRan = false;

      const promise = pausedQueue.enqueue(() => { taskRan = true; return Promise.resolve(); });
      const taskId = [...pausedQueue.tasks.keys()][0];

      const cancelled = pausedQueue.cancel(taskId);
      assert.ok(cancelled);

      pausedQueue.resume();

      await assert.rejects(promise, /cancelled/);
      assert.ok(!taskRan);

      pausedQueue.destroy();
    });

    it('should not cancel running task', async () => {
      let resolve;
      const taskPromise = queue.enqueue(() => new Promise(r => { resolve = r; }));

      // Wait for task to start
      await new Promise(r => setTimeout(r, 10));

      const taskId = [...queue.tasks.keys()][0];
      const cancelled = queue.cancel(taskId);

      assert.ok(!cancelled);

      resolve('done');
      await taskPromise;
    });

    it('should emit task:cancelled event', async () => {
      const pausedQueue = new TaskQueue({ autoStart: false });
      let cancelledEvent = null;
      pausedQueue.on('task:cancelled', (e) => { cancelledEvent = e; });

      const promise = pausedQueue.enqueue(() => Promise.resolve());
      const taskId = [...pausedQueue.tasks.keys()][0];
      pausedQueue.cancel(taskId);

      // Handle the rejected promise
      await assert.rejects(promise, /cancelled/);

      assert.ok(cancelledEvent);
      assert.strictEqual(cancelledEvent.taskId, taskId);

      pausedQueue.destroy();
    });
  });

  describe('getTask', () => {
    it('should return task info', async () => {
      queue.enqueue(() => Promise.resolve(), { description: 'test', priority: Priority.HIGH });
      const taskId = [...queue.tasks.keys()][0];

      const task = queue.getTask(taskId);
      assert.ok(task);
      assert.strictEqual(task.description, 'test');
      assert.strictEqual(task.priority, Priority.HIGH);
    });

    it('should return null for unknown task', () => {
      const task = queue.getTask('unknown-id');
      assert.strictEqual(task, null);
    });
  });

  describe('pause and resume', () => {
    it('should pause processing', async () => {
      queue.pause();
      let taskRan = false;

      const promise = queue.enqueue(() => { taskRan = true; return Promise.resolve(); });

      await new Promise(r => setTimeout(r, 50));
      assert.ok(!taskRan);
      assert.ok(queue.getStats().paused);

      // Cancel the queued task before destroying to avoid unhandled rejection
      const taskId = [...queue.tasks.keys()][0];
      queue.cancel(taskId);
      await assert.rejects(promise, /cancelled/);
    });

    it('should resume processing', async () => {
      queue.pause();
      let taskRan = false;

      const promise = queue.enqueue(() => { taskRan = true; return Promise.resolve(); });

      queue.resume();
      await promise;

      assert.ok(taskRan);
    });
  });

  describe('getStats', () => {
    it('should return accurate statistics', async () => {
      // Add some tasks
      await queue.enqueue(() => Promise.resolve());

      try {
        await queue.enqueue(() => Promise.reject(new Error('fail')));
      } catch {}

      const stats = queue.getStats();
      assert.strictEqual(stats.completed, 1);
      assert.strictEqual(stats.failed, 1);
      assert.strictEqual(stats.total, 2);
    });
  });

  describe('listTasks', () => {
    it('should list all tasks', async () => {
      await queue.enqueue(() => Promise.resolve());
      await queue.enqueue(() => Promise.resolve());

      const tasks = queue.listTasks();
      assert.strictEqual(tasks.length, 2);
    });

    it('should filter by status', async () => {
      await queue.enqueue(() => Promise.resolve());

      try {
        await queue.enqueue(() => Promise.reject(new Error('fail')));
      } catch {}

      const failed = queue.listTasks({ status: TaskStatus.FAILED });
      assert.strictEqual(failed.length, 1);
      assert.strictEqual(failed[0].status, TaskStatus.FAILED);
    });
  });

  describe('clearCompleted', () => {
    it('should clear completed, failed, and cancelled tasks', async () => {
      await queue.enqueue(() => Promise.resolve());

      try {
        await queue.enqueue(() => Promise.reject(new Error('fail')));
      } catch {}

      assert.strictEqual(queue.getStats().total, 2);

      const cleared = queue.clearCompleted();
      assert.strictEqual(cleared, 2);
      assert.strictEqual(queue.getStats().total, 0);
    });
  });
});

describe('Singleton functions', () => {
  afterEach(() => {
    resetTaskQueue();
  });

  describe('getTaskQueue', () => {
    it('should return the same instance on multiple calls', () => {
      const queue1 = getTaskQueue();
      const queue2 = getTaskQueue();
      assert.strictEqual(queue1, queue2);
    });

    it('should accept config on first call', () => {
      const queue = getTaskQueue({ maxConcurrent: 5 });
      assert.strictEqual(queue.getStats().maxConcurrent, 5);
    });
  });

  describe('resetTaskQueue', () => {
    it('should reset the singleton', () => {
      const queue1 = getTaskQueue({ maxConcurrent: 5 });
      resetTaskQueue();
      const queue2 = getTaskQueue({ maxConcurrent: 10 });

      assert.strictEqual(queue2.getStats().maxConcurrent, 10);
    });
  });
});

describe('Priority constants', () => {
  it('should have correct priority ordering', () => {
    assert.ok(Priority.URGENT < Priority.HIGH);
    assert.ok(Priority.HIGH < Priority.NORMAL);
    assert.ok(Priority.NORMAL < Priority.LOW);
    assert.ok(Priority.LOW < Priority.BACKGROUND);
  });
});
