/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { nonNullValue, openReadOnlyJson, type IActionContext } from '@microsoft/vscode-azext-utils';
import { localize } from '../localize';
import { type SiteTreeItem } from '../tree/SiteTreeItem';

export async function viewProperties(context: IActionContext, treeItem?: SiteTreeItem): Promise<void> {
    const node = nonNullValue(treeItem);
    await node.initSite(context);
    const client = await node.site.createClient(context);
    await node.runWithTemporaryDescription(context, localize('retrievingProps', 'Retrieving properties...'), async () => {
        // `siteConfig` already exists on `node.site`, but has very limited properties for some reason. We want to get the full site config
        nonNullValue(node).site.rawSite.siteConfig = await client.getSiteConfig();
    });

    await openReadOnlyJson(node, node.site.rawSite);
}
