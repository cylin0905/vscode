/*---------------------------------------------------------------------------------------------
 *  Copyright (c) iShell contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IIshellService, ISHELL_IPC_CHANNEL } from '../common/ishell.js';

// @ts-expect-error: 接口经 Proxy 代理实现
export class IshellService implements IIshellService {

	declare readonly _serviceBrand: undefined;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		return ProxyChannel.toService<IIshellService>(mainProcessService.getChannel(ISHELL_IPC_CHANNEL));
	}
}
