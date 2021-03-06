import * as fs from 'fs/promises';
import {watch as fsWatch, existsSync as fsExistsSync} from 'fs';
import type {FSWatcher, BigIntStats} from 'fs';
import * as assert from 'assert';

type WatcherSetup = {
  running: boolean;
};

type Descriptor = {
  fd: fs.FileHandle;
  buffer: string;
  stat: BigIntStats;
};

type IteratorState<T> = {
  running: boolean;
  push_queue: Array<T>;
  pull_queue: Array<(v: IteratorYieldResult<T>) => void>;
};

type WatchEvent = {
  eventType: 'change' | 'rename';
  filename: string;
};

type FSWatcherWithIterator = FSWatcher & {
  stat: BigIntStats;
  [Symbol.asyncIterator]: () => any;
};

export class FileTailer {
  filepath: string;
  watcher: FSWatcherWithIterator | null;
  watching: boolean;
  watcher_setup: WatcherSetup | null;
  descriptor: Descriptor | null;
  logger: Console;

  constructor(filepath: string, logger: Console = console) {
    this.filepath = filepath;
    this.watcher = null;
    this.watching = false;
    this.watcher_setup = null;
    this.descriptor = null;
    this.logger = logger;
  }

  async *watch(): AsyncGenerator<string, void, unknown> {
    assert(!this.watching, "Can't watch multiple times");
    this.watching = true;
    try {
      while (true) {
        let descriptor = (this.descriptor = await this._openFile(
          this.filepath
        ));

        const watcher = await this._setupWatcher();
        if (watcher === null) {
          // cancelled before the watcher set up
          // we've been stop()'d
          break;
        }

        if (descriptor === null) {
          descriptor = this.descriptor = await this._openFile(this.filepath);
        } else {
          for await (const line of this._readLines(descriptor)) {
            yield line;
          }
        }

        if (descriptor === null) {
          // File deleted after watch
          this.logger.info('File deleted after watch, re-tailing');
          this.stop();
          continue;
        }

        if (descriptor.stat.ino !== watcher.stat.ino) {
          this.logger.info('File mismatch between fd and watch, re-tailing');
          this.stop();
          continue;
        }

        this.logger.info(`Now watching file ${this.filepath} for changes`);
        // Control variable so we can know to continue the outer loop without breaking the inner loop
        let re_watch = false;

        for await (const {eventType, filename} of watcher) {
          const new_stat = await this._stat(this.filepath);
          if (new_stat !== null && new_stat.ino !== descriptor.stat.ino) {
            this.logger.info(`File ${filename} went away, re-tailing`);
            this.stop();
            // We don't break out of the loop here, because we want to finish processing events
            re_watch = true;
          }

          if (eventType === 'change') {
            this.logger.info(`File ${filename} changed, reading next data`);
          } else if (eventType === 'rename') {
            this.logger.info(`File ${filename} was renamed`);
          }

          for await (const line of this._readLines(descriptor)) {
            yield line;
          }
        }
        descriptor.fd.close();
        if (re_watch) {
          continue;
        }

        break;
      }
    } finally {
      if (this.descriptor !== null) {
        this.descriptor.fd.close();
        this.descriptor = null;
      }
      this.stop();
      this.watching = false;
    }
  }

  private async _openFile(filepath: string): Promise<Descriptor | null> {
    if (!fsExistsSync(filepath)) {
      return null;
    }
    try {
      const fd = await fs.open(filepath, 'r');
      const file_descriptor = {
        fd,
        stat: await fd.stat({bigint: true}),
        buffer: '',
      };
      return file_descriptor;
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        return null;
      }
      throw e;
    }
  }

  private async _stat(filepath: string): Promise<BigIntStats | null> {
    try {
      return await fs.stat(filepath, {bigint: true});
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        return null;
      }
      throw e;
    }
  }

  private _watchIterator(iterator_state: IteratorState<WatchEvent>) {
    return {
      next(): Promise<IteratorResult<WatchEvent, undefined>> {
        if (iterator_state.running || iterator_state.push_queue.length !== 0) {
          return new Promise(resolve => {
            if (iterator_state.push_queue.length !== 0) {
              const value = iterator_state.push_queue.shift();
              // This can't be undefined because of the check above, but make typescript happy
              if (value) {
                resolve({value, done: false});
              }
            } else {
              iterator_state.pull_queue.push(resolve);
            }
          });
        } else {
          return Promise.resolve({value: undefined, done: true});
        }
      },
    };
  }

  private async _setupWatcher(): Promise<FSWatcherWithIterator | null> {
    const watcher_setup = (this.watcher_setup = {running: true});
    this.watcher = null;
    try {
      do {
        if (!watcher_setup.running) {
          return null;
        }
        try {
          const iterator_state: IteratorState<WatchEvent> = {
            push_queue: [{eventType: 'change', filename: this.filepath}],
            pull_queue: [],
            running: true,
          };
          // We need to watch out for motion blur while setting to set up the watcher
          // Otherwise, the watcher might end up watching an entirely different file than the file descriptor
          const initial_stat = await fs.stat(this.filepath, {bigint: true});
          const watcher = fsWatch(this.filepath, (eventType, filename) => {
            const value = {eventType, filename};
            if (iterator_state.pull_queue.length !== 0) {
              const resolver = iterator_state.pull_queue.shift();
              // This can't be undefined because of the check above, but make typescript happy
              if (resolver) {
                resolver({value, done: false});
              }
            } else {
              iterator_state.push_queue.push(value);
            }
          });
          watcher.on('close', () => (iterator_state.running = false));
          const end_stat = await fs.stat(this.filepath, {bigint: true});
          // If inodes differ, we can't be sure to pick up the latest changes,
          // so we just retry the loop until we get a stable inode
          // If the initial inode is different from the end inode, the
          // actual watched inode is in between there somewhere - we might have missed an update
          // If they are equal, we can be pretty sure that the file didn't change in between, and that the watch is reading the same file.
          // This is not true in the case of the sequence
          // stat(a) -> rename(a, c) -> rename(b, a) -> watch(a) -> rename(a, b) -> rename(c, a) -> stat(a)
          // In this case, we check if the ctime changed, but the mtime stayed the same
          if (
            initial_stat.ino !== end_stat.ino ||
            (initial_stat.ctime !== end_stat.ctime &&
              initial_stat.mtime === end_stat.mtime)
          ) {
            watcher.close();
            continue;
          }
          (watcher as FSWatcherWithIterator).stat = end_stat;
          const watchIterator = this._watchIterator(iterator_state);
          (watcher as FSWatcherWithIterator)[Symbol.asyncIterator] = () =>
            watchIterator;
          this.watcher = watcher as FSWatcherWithIterator;
          return this.watcher;
        } catch (e: any) {
          if (e.code === 'ENOENT') {
            // might be thrown by either fs.stat or fsWatch
            if (this.watcher !== null) {
              this.watcher.close();
              this.watcher = null;
            }
            // the worker's state file does not exist yet so we should check again in 100ms
            await new Promise(resolve => setTimeout(resolve, 100));
          } else {
            throw e;
          }
        }
        // eslint-disable-next-line no-constant-condition
      } while (true);
    } finally {
      this.watcher_setup = null;
    }
  }

  private async *_readLines(
    descriptor: Descriptor | null
  ): AsyncGenerator<string, void, unknown> {
    assert(descriptor !== null, 'Did not expect descriptor to be null');
    const buffer = Buffer.alloc(1024);
    while (true) {
      // @ts-expect-error TS has the wrong signature for this function
      const {bytesRead} = await descriptor.fd.read({buffer});
      if (bytesRead === 0) {
        break;
      }
      const parts = (
        descriptor.buffer + buffer.toString('utf-8', 0, bytesRead)
      ).split('\r\n');
      // I don't know why eslint dislikes this code, the update is clearly atomic
      // eslint-disable-next-line require-atomic-updates
      // TS thinks this can be undefined - that's not correct
      descriptor.buffer = parts.pop() as string;

      for (const line of parts) {
        yield line;
      }
    }
  }

  stop() {
    if (this.watcher_setup !== null) {
      this.watcher_setup.running = false;
      this.watcher_setup = null;
    }
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

export default FileTailer;
