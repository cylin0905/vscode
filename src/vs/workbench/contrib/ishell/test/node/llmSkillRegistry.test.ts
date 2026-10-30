/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LlmSkillRegistry, validateSkillRegistration, BUILTIN_SKILLS } from '../../node/llmSkillRegistry.js';

/** 断言 Promise 以匹配 re 的消息 reject */
async function assertRejects(promise: Promise<unknown>, re: RegExp): Promise<void> {
	try {
		await promise;
	} catch (err) {
		assert.match((err as Error).message, re);
		return;
	}
	assert.fail(`预期抛出匹配 ${re} 的错误，但 Promise 正常完成`);
}

suite('iShell/llmSkillRegistry', () => {

	let skillsDir: string;
	let persistedPath: string;
	let registry: LlmSkillRegistry;

	const validManifest = {
		id: 'acme.deploy-helper',
		name: '部署助手',
		description: '按项目规范生成部署命令',
		version: '1.2.0',
		triggers: ['部署', 'deploy'],
		instruction: '用户要求部署时输出部署检查清单与命令。',
	};

	setup(() => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ishell-skills-'));
		skillsDir = path.join(tmp, 'skills');
		persistedPath = path.join(tmp, 'skills-registered.json');
		registry = new LlmSkillRegistry(skillsDir, persistedPath);
	});

	teardown(() => {
		fs.rmSync(path.dirname(skillsDir), { recursive: true, force: true });
	});

	suite('validateSkillRegistration', () => {

		test('合法清单通过并规范化', () => {
			const check = validateSkillRegistration({ ...validManifest, extensionId: 'acme.ext' });
			assert.strictEqual(check.errors.length, 0);
			assert.ok(check.value);
			assert.strictEqual(check.value.id, 'acme.deploy-helper');
			assert.strictEqual(check.value.extensionId, 'acme.ext');
		});

		test('非法 id / version / triggers 各自报错', () => {
			assert.ok(validateSkillRegistration({ ...validManifest, id: 'BAD ID' }).errors.length > 0);
			assert.ok(validateSkillRegistration({ ...validManifest, version: 'v1' }).errors.length > 0);
			assert.ok(validateSkillRegistration({ ...validManifest, triggers: [] }).errors.length > 0);
			assert.strictEqual(validateSkillRegistration('not-an-object').errors.length, 1);
		});
	});

	suite('load / list', () => {

		test('内置 Skill 全量加载', async () => {
			await registry.load();
			const list = registry.list();
			assert.strictEqual(list.filter(s => s.origin === 'builtin').length, BUILTIN_SKILLS.length);
			assert.ok(registry.get('ishell.generate-code'));
			assert.ok(!registry.get('ishell.not-exist'));
		});
	});

	suite('user Skill 注册', () => {

		test('注册后落盘目录并可查询', async () => {
			const manifest = await registry.register(validManifest);
			assert.strictEqual(manifest.origin, 'user');
			assert.ok(registry.get(validManifest.id));

			const filePath = path.join(skillsDir, `${validManifest.id}.json`);
			const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { id: string };
			assert.strictEqual(raw.id, validManifest.id);
		});

		test('目录 JSON 热加载（重启后仍可见）', async () => {
			await registry.register(validManifest);
			const reopened = new LlmSkillRegistry(skillsDir, persistedPath);
			await reopened.load();
			const loaded = reopened.get(validManifest.id);
			assert.ok(loaded);
			assert.strictEqual(loaded.origin, 'user');
			assert.strictEqual(loaded.enabled, true);
		});

		test('拒绝覆盖内置 Skill', async () => {
			await assertRejects(registry.register({ ...validManifest, id: 'ishell.generate-code' }), /内置/);
		});

		test('卸载 user Skill：文件删除、列表移除', async () => {
			await registry.register(validManifest);
			await registry.unregister(validManifest.id);
			assert.ok(!registry.get(validManifest.id));
			assert.throws(() => fs.accessSync(path.join(skillsDir, `${validManifest.id}.json`)));
		});
	});

	suite('extension Skill 注册', () => {

		test('extensionId 注册持久化到 registered.json', async () => {
			const manifest = await registry.register({ ...validManifest, extensionId: 'acme.extension' });
			assert.strictEqual(manifest.origin, 'extension');

			const raw = JSON.parse(fs.readFileSync(persistedPath, 'utf8')) as { manifest: { id: string } }[];
			assert.ok(raw.some(e => e.manifest.id === validManifest.id));

			const reopened = new LlmSkillRegistry(skillsDir, persistedPath);
			await reopened.load();
			const loaded = reopened.get(validManifest.id);
			assert.ok(loaded);
			assert.strictEqual(loaded.origin, 'extension');
		});

		test('卸载 extension Skill：持久化项移除', async () => {
			await registry.register({ ...validManifest, extensionId: 'acme.extension' });
			await registry.unregister(validManifest.id);
			const raw = JSON.parse(fs.readFileSync(persistedPath, 'utf8')) as { manifest: { id: string } }[];
			assert.ok(!raw.some(e => e.manifest.id === validManifest.id));
		});
	});

	suite('内置 Skill 拒绝卸载', () => {

		test('unregister(builtin) 抛错', async () => {
			await assertRejects(registry.unregister('ishell.generate-code'), /内置/);
		});
	});

	suite('启停切换（setEnabled）', () => {

		test('内置停用后重启仍保持禁用', async () => {
			await registry.setEnabled('ishell.generate-code', false);
			assert.strictEqual(registry.get('ishell.generate-code')?.enabled, false);

			const disabledPath = path.join(skillsDir, 'builtin-disabled.json');
			const ids = JSON.parse(fs.readFileSync(disabledPath, 'utf8')) as string[];
			assert.ok(ids.includes('ishell.generate-code'));

			const reopened = new LlmSkillRegistry(skillsDir, persistedPath);
			await reopened.load();
			assert.strictEqual(reopened.get('ishell.generate-code')?.enabled, false);

			await registry.setEnabled('ishell.generate-code', true);
			assert.strictEqual(registry.get('ishell.generate-code')?.enabled, true);
		});

		test('user Skill 启停写入目录 JSON 并随加载恢复', async () => {
			await registry.register(validManifest);
			await registry.setEnabled(validManifest.id, false);

			const raw = JSON.parse(fs.readFileSync(path.join(skillsDir, `${validManifest.id}.json`), 'utf8')) as { enabled: boolean };
			assert.strictEqual(raw.enabled, false);

			const reopened = new LlmSkillRegistry(skillsDir, persistedPath);
			await reopened.load();
			assert.strictEqual(reopened.get(validManifest.id)?.enabled, false);
		});

		test('extension Skill 启停持久化', async () => {
			await registry.register({ ...validManifest, extensionId: 'acme.extension' });
			await registry.setEnabled(validManifest.id, false);

			const raw = JSON.parse(fs.readFileSync(persistedPath, 'utf8')) as { manifest: { id: string; enabled: boolean } }[];
			const entry = raw.find(e => e.manifest.id === validManifest.id);
			assert.ok(entry);
			assert.strictEqual(entry.manifest.enabled, false);
		});

		test('不存在的 Skill 报错', async () => {
			await assertRejects(registry.setEnabled('not.exist', true), /不存在/);
		});
	});
});
