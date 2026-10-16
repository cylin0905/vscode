/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

// #########################################################################
// ##                        iShell 连接管理公共契约                        ##
// ##  本文件被渲染进程（browser/electron-sandbox）与主进程（electron-main） ##
// ##  共同引用，所有类型必须可 JSON 序列化（经 IPC 通道传输）。             ##
// #########################################################################

/** IPC 通道名（主进程 <-> 渲染进程） */
export const ISHELL_IPC_CHANNEL = 'ishell';

// ==== 主机档案 ====

export type SshAuthMethod = 'password' | 'key' | 'agent';

export interface IHostGroup {
	id: string;
	name: string;
}

export interface IHostProfile {
	id: string;
	/** 显示别名 */
	name: string;
	host: string;
	port: number;
	username: string;
	authMethod: SshAuthMethod;
	/** 密钥文件路径（authMethod = 'key'） */
	keyPath?: string;
	/** SSH Agent 管道（authMethod = 'agent'，缺省自动探测） */
	agentPipe?: string;
	/** safeStorage(DPAPI) 加密后的密码或密钥口令密文，落盘 100% 密文 */
	encSecret?: string;
	groupId?: string;
	tags?: string[];
}

export interface IConnectionsData {
	version: 1;
	groups: IHostGroup[];
	hosts: IHostProfile[];
}

// ==== 连接状态 ====

export type SshConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export type ConnectErrorCode = 'auth-failed' | 'hostkey-mismatch' | 'hostkey-rejected' | 'timeout' | 'network' | 'unknown';

export interface ISshConnectionSnapshot {
	/** 会话 id：已存档案的连接 = profileId；快速连接 = quick:<uuid> */
	id: string;
	label: string;
	host: string;
	port: number;
	username: string;
	status: SshConnectionStatus;
	/** 状态详情（错误信息 / 重连进度） */
	detail?: string;
	errorCode?: ConnectErrorCode;
	/** reconnecting 状态下的已重试次数 */
	retryCount?: number;
}

export interface IHostKeyPrompt {
	sessionId: string;
	host: string;
	port: number;
	/** 例如 ssh-ed25519 */
	keyAlgorithm: string;
	/** 形如 SHA256:xxxxx */
	fingerprint: string;
}

// ==== 快速连接（不落盘） ====

export interface IQuickConnectTarget {
	host: string;
	port: number;
	username: string;
	authMethod: SshAuthMethod;
	keyPath?: string;
	agentPipe?: string;
	/** 明文凭据，仅经 IPC 内存传递，主进程保存在内存中用于自动重连 */
	secret?: string;
}

// ==== 服务接口 ====

export const IIshellService = createDecorator<IIshellService>('IIshellService');

export interface IIshellService {

	readonly _serviceBrand: undefined;

	// ---- 档案管理 ----

	getProfiles(): Promise<IConnectionsData>;
	/** 保存（新增或更新）主机档案；secret 为明文密码/口令（会加密后落盘） */
	saveProfile(profile: IHostProfile, secret?: string | undefined): Promise<IHostProfile>;
	deleteProfile(id: string): Promise<void>;

	createGroup(name: string): Promise<IHostGroup>;
	renameGroup(id: string, name: string): Promise<void>;
	/** deleteHosts=true 时删除组内主机；否则组内主机移入"未分组" */
	deleteGroup(id: string, deleteHosts: boolean): Promise<void>;
	moveProfileToGroup(profileId: string, groupId: string | undefined): Promise<void>;

	// ---- 连接管理 ----

	/** 连接已存档的主机。secret 用于本次连接（未存档密码时由 UI 询问） */
	connect(profileId: string, secret?: string | undefined): Promise<void>;
	/** 快速连接（不落盘），返回会话 id（quick:<uuid>） */
	quickConnect(target: IQuickConnectTarget): Promise<string>;
	disconnect(sessionId: string): Promise<void>;
	getConnections(): Promise<ISshConnectionSnapshot[]>;
	/** 用户对主机指纹确认框的选择 */
	confirmHostKey(sessionId: string, accepted: boolean): Promise<void>;

	// ---- 事件 ----

	readonly onDidChangeProfiles: Event<void>;
	/** undefined 表示需要全量刷新（如会话列表增删） */
	readonly onDidChangeConnections: Event<ISshConnectionSnapshot | undefined>;
	/** 主进程请求渲染进程弹出指纹确认框 */
	readonly onDidRequestHostKeyConfirm: Event<IHostKeyPrompt>;
}
