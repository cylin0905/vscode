/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Load styles for the remaining onboarding variant.
import './media/variationA.css';

import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import product from '../../../../platform/product/common/product.js';
import { IOnboardingService } from '../common/onboardingService.js';
import { OnboardingVariationA } from './onboardingVariationA.js';

// iShell: the onboarding wizard depends on a default chat agent (Copilot) product
// configuration. The service itself is always registered because other
// contributions (e.g. the getting-started startup page) depend on it, but it
// stays inert when the configuration is absent (see OnboardingVariationA.show).
registerSingleton(IOnboardingService, OnboardingVariationA, InstantiationType.Delayed);

if (product.defaultChatAgent) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.welcomeOnboarding2026',
				title: localize2('welcomeOnboarding2026', "Welcome Onboarding 2026"),
				category: Categories.Developer,
				f1: true,
			});
		}

		run(accessor: ServicesAccessor): void {
			const onboardingService = accessor.get(IOnboardingService);
			onboardingService.show();
		}
	});
}
