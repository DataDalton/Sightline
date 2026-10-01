import assert from "node:assert/strict";
import { test } from "node:test";
import { createGate } from "./gate";
import { createLineReader } from "./ndjson";

// A task that finishes only when the test says so.
function deferred(): { promise: Promise<void>; finish: () => void } {
	let finish = () => {};
	const promise = new Promise<void>((resolve) => {
		finish = resolve;
	});
	return { promise, finish };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a gate runs no more than its limit at once", async () => {
	const gate = createGate(2);
	const tasks = [deferred(), deferred(), deferred(), deferred()];
	let peak = 0;
	let running = 0;
	const done = tasks.map((task) =>
		gate.run(async () => {
			running++;
			peak = Math.max(peak, running);
			await task.promise;
			running--;
		}),
	);
	await tick();
	assert.equal(gate.active(), 2);
	assert.equal(gate.queued(), 2);
	for (const task of tasks) {
		task.finish();
		await tick();
	}
	await Promise.all(done);
	assert.equal(peak, 2);
	assert.equal(gate.active(), 0);
	assert.equal(gate.queued(), 0);
});

test("a gate starts waiting tasks in arrival order", async () => {
	const gate = createGate(1);
	const first = deferred();
	const order: number[] = [];
	const done = [
		gate.run(async () => {
			await first.promise;
			order.push(0);
		}),
		gate.run(async () => {
			order.push(1);
		}),
		gate.run(async () => {
			order.push(2);
		}),
	];
	first.finish();
	await Promise.all(done);
	assert.deepEqual(order, [0, 1, 2]);
});

test("a failing task frees its slot and passes the error on", async () => {
	const gate = createGate(1);
	await assert.rejects(
		gate.run(async () => {
			throw new Error("boom");
		}),
		/boom/,
	);
	const thrown = gate.run(() => {
		throw new Error("sync");
	});
	await assert.rejects(thrown, /sync/);
	assert.equal(await gate.run(async () => 7), 7);
	assert.equal(gate.active(), 0);
});

test("tryRun drops a task once the queue is past its bound", async () => {
	const gate = createGate(1);
	const held = deferred();
	const running = gate.run(() => held.promise);
	const queued = gate.tryRun(async () => "queued", 1);
	assert.ok(queued);
	assert.equal(
		gate.tryRun(async () => "dropped", 1),
		null,
	);
	held.finish();
	await running;
	assert.equal(await queued, "queued");
});

test("a line reader joins lines split across chunks", () => {
	const lines: string[] = [];
	const reader = createLineReader((line) => lines.push(line));
	reader.push('{"i":0}\n{"i"');
	reader.push(':1}\n\n{"i":2}');
	assert.deepEqual(lines, ['{"i":0}', '{"i":1}']);
	reader.end();
	assert.deepEqual(lines, ['{"i":0}', '{"i":1}', '{"i":2}']);
});
