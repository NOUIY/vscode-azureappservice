/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type NameValuePair, type Site, type SiteConfig, type WebSiteManagementClient } from '@azure/arm-appservice';
import { createHttpHeaders, createPipelineRequest } from '@azure/core-rest-pipeline';
import { createWebSiteClient, DomainNameLabelScope, WebsiteOS, type CustomLocation } from '@microsoft/vscode-azext-azureappservice';
import { createGenericClient, LocationListStep, type AzExtPipelineResponse, type AzExtRequestPrepareOptions } from '@microsoft/vscode-azext-azureutils';
import { AzureWizardExecuteStepWithActivityOutput, nonNullProp } from '@microsoft/vscode-azext-utils';
import { type AppResource } from '@microsoft/vscode-azext-utils/hostapi';
import { type Progress } from 'vscode';
import { webProvider } from '../../constants';
import { localize } from '../../localize';
import { type SitePayload } from './domainLabelScopeTypes';
import { type FullJavaStack, type FullWebAppStack, type IWebAppWizardContext } from './IWebAppWizardContext';
import { getJavaLinuxRuntime } from './stacks/getJavaLinuxRuntime';
import { type WebAppStackValue, type WindowsJavaContainerSettings } from './stacks/models/WebAppStackModel';

export class WebAppCreateStep extends AzureWizardExecuteStepWithActivityOutput<IWebAppWizardContext> {
    public priority: number = 140;
    public stepName: string = 'webAppCreateStep';
    protected getOutputLogSuccess = (context: IWebAppWizardContext): string =>
        localize('createdWebApp', 'Successfully created web app "{0}": {1}', context.newSiteName, context.site?.defaultHostName);
    protected getOutputLogFail = (context: IWebAppWizardContext): string =>
        localize('failedToCreateWebApp', 'Failed to create web app "{0}"', context.newSiteName);
    protected getTreeItemLabel = (context: IWebAppWizardContext): string =>
        localize('createWebApp', 'Create web app "{0}"', context.newSiteName);

    public async execute(context: IWebAppWizardContext, progress: Progress<{ message?: string; increment?: number }>): Promise<void> {
        context.telemetry.properties.newSiteOS = context.newSiteOS;
        context.telemetry.properties.newSiteStack = context.newSiteStack?.stack.value;
        context.telemetry.properties.newSiteMajorVersion = context.newSiteStack?.majorVersion.value;
        context.telemetry.properties.newSiteMinorVersion = context.newSiteStack?.minorVersion.value;
        if (context.newSiteJavaStack) {
            context.telemetry.properties.newSiteJavaStack = context.newSiteJavaStack.stack.value;
            context.telemetry.properties.newSiteJavaMajorVersion = context.newSiteJavaStack.majorVersion.value;
            context.telemetry.properties.newSiteJavaMinorVersion = context.newSiteJavaStack.minorVersion.value;
        }
        context.telemetry.properties.planSkuTier = context.plan && context.plan.sku && context.plan.sku.tier;

        const message: string = localize('creatingNewApp', 'Creating new web app "{0}"...', context.newSiteName);
        progress.report({ message });

        const siteName: string = nonNullProp(context, 'newSiteName');
        const rgName: string = nonNullProp(nonNullProp(context, 'resourceGroup'), 'name');

        context.site = await this.createWebApp(context, rgName, siteName);
        context.activityResult = context.site as AppResource;
    }

    public shouldExecute(context: IWebAppWizardContext): boolean {
        return !context.site;
    }

    private async createWebApp(context: IWebAppWizardContext, rgName: string, siteName: string): Promise<Site> {
        return context.newSiteDomainNameLabelScope === DomainNameLabelScope.Global ?
            await this.createNewSite(context, rgName, siteName) :
            await this.createNewSiteWithDomainLabelScope(context, rgName, siteName);
    }

    // #region createNewSite
    private async createNewSite(context: IWebAppWizardContext, rgName: string, siteName: string): Promise<Site> {
        const client: WebSiteManagementClient = await createWebSiteClient(context);
        return await client.webApps.beginCreateOrUpdateAndWait(rgName, siteName, await this.getNewSite(context));
    }

    private async getNewSite(context: IWebAppWizardContext): Promise<Site> {
        const location = await LocationListStep.getLocation(context, webProvider);
        const newSiteConfig: SiteConfig = this.getSiteConfig(context);

        const site: Site = {
            name: context.newSiteName,
            kind: this.getKind(context),
            location: nonNullProp(location, 'name'),
            serverFarmId: context.plan && context.plan.id,
            clientAffinityEnabled: true,
            siteConfig: newSiteConfig,
            reserved: context.newSiteOS === WebsiteOS.linux  // The secret property - must be set to true to make it a Linux plan. Confirmed by the team who owns this API.
        };

        if (context.customLocation) {
            this.addCustomLocationProperties(site, context.customLocation);
        }

        return site;
    }
    // #endregion

    // #region createNewSiteWithDomainLabelScope
    private async createNewSiteWithDomainLabelScope(context: IWebAppWizardContext, rgName: string, siteName: string): Promise<Site> {
        // The SDK does not currently support this updated api version, so we should make the call to the endpoint manually until the SDK gets updated
        const apiVersion: string = '2024-04-01';
        const authToken = (await context.credentials.getToken() as { token?: string }).token;
        const options: AzExtRequestPrepareOptions = {
            url: `${context.environment.resourceManagerEndpointUrl}subscriptions/${context.subscriptionId}/resourceGroups/${rgName}/providers/Microsoft.Web/sites/${siteName}?api-version=${apiVersion}`,
            method: 'PUT',
            headers: createHttpHeaders({
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`,
            }),
            body: JSON.stringify(await this.getNewSiteWithDomainLabelScope(context)),
        };

        const client = await createGenericClient(context, undefined);
        // We don't care about storing the response here because the manual response returned is different from the SDK formatting that our code expects.
        // The stored site should come from the SDK instead.
        await client.sendRequest(createPipelineRequest(options)) as AzExtPipelineResponse;

        const sdkClient: WebSiteManagementClient = await createWebSiteClient(context);
        return await sdkClient.webApps.get(rgName, siteName);
    }

    private async getNewSiteWithDomainLabelScope(context: IWebAppWizardContext): Promise<SitePayload> {
        const location = await LocationListStep.getLocation(context, webProvider);
        const newSiteConfig: SiteConfig = this.getSiteConfig(context);

        const sitePayload: SitePayload = {
            name: context.newSiteName,
            kind: this.getKind(context),
            location: nonNullProp(location, 'name'),
            properties: {
                autoGeneratedDomainNameLabelScope: context.newSiteDomainNameLabelScope,
                clientAffinityEnabled: true,
                serverFarmId: context.plan && context.plan.id,
                reserved: context.newSiteOS === WebsiteOS.linux, // The secret property - must be set to true to make it a Linux plan. Confirmed by the team who owns this API.
                siteConfig: newSiteConfig,
            },
        };

        if (context.customLocation) {
            this.addCustomLocationProperties(sitePayload, context.customLocation);
        }

        return sitePayload;
    }
    // #endregion

    private getKind(context: IWebAppWizardContext): string {
        let kind: string = context.newSiteKind;
        if (context.newSiteOS === 'linux') {
            kind += ',linux';
        }
        if (context.customLocation) {
            kind += ',kubernetes';
        }
        return kind;
    }

    private addCustomLocationProperties(site: Site | SitePayload, customLocation: CustomLocation): void {
        site.extendedLocation = { name: customLocation.id, type: 'customLocation' };
    }

    private getSiteConfig(context: IWebAppWizardContext): SiteConfig {
        const newSiteConfig: SiteConfig = {};

        newSiteConfig.appSettings = this.getAppSettings(context);

        const stack: FullWebAppStack = nonNullProp(context, 'newSiteStack');
        if (context.newSiteOS === WebsiteOS.linux) {
            newSiteConfig.linuxFxVersion = stack.stack.value === 'java' ?
                getJavaLinuxRuntime(stack.majorVersion.value, nonNullProp(context, 'newSiteJavaStack').minorVersion) :
                nonNullProp(stack.minorVersion.stackSettings, 'linuxRuntimeSettings').runtimeVersion;
        } else {
            const runtimeVersion: string = nonNullProp(stack.minorVersion.stackSettings, 'windowsRuntimeSettings').runtimeVersion;
            switch (stack.stack.value) {
                case 'dotnet':
                    if (!/core/i.test(stack.minorVersion.displayText)) { // Filter out .NET _Core_ stacks because this is a .NET _Framework_ property
                        newSiteConfig.netFrameworkVersion = runtimeVersion;
                    }
                    break;
                case 'php':
                    newSiteConfig.phpVersion = runtimeVersion;
                    break;
                case 'node':
                    newSiteConfig.nodeVersion = runtimeVersion;
                    newSiteConfig.appSettings.push({
                        name: 'WEBSITE_NODE_DEFAULT_VERSION',
                        value: runtimeVersion
                    });
                    break;
                case 'java':
                    newSiteConfig.javaVersion = runtimeVersion;
                    const javaStack: FullJavaStack = nonNullProp(context, 'newSiteJavaStack');
                    const windowsStackSettings: WindowsJavaContainerSettings = nonNullProp(javaStack.minorVersion.stackSettings, 'windowsContainerSettings');
                    newSiteConfig.javaContainer = windowsStackSettings.javaContainer;
                    newSiteConfig.javaContainerVersion = windowsStackSettings.javaContainerVersion;
                    break;
                case 'python':
                    newSiteConfig.pythonVersion = runtimeVersion;
                    break;
                default:
            }
        }
        return newSiteConfig;
    }

    private getAppSettings(context: IWebAppWizardContext): NameValuePair[] {
        const appSettings: NameValuePair[] = [];
        const disabled: string = 'disabled';
        const trueString: string = 'true';

        const runtime: WebAppStackValue = nonNullProp(context, 'newSiteStack').stack.value;
        if (context.newSiteOS === WebsiteOS.linux && (runtime === 'node' || runtime === 'python')) {
            appSettings.push({
                name: 'SCM_DO_BUILD_DURING_DEPLOYMENT',
                value: trueString
            });
        }
        if (context.appInsightsComponent) {
            appSettings.push({
                name: 'APPLICATIONINSIGHTS_CONNECTION_STRING',
                value: context.appInsightsComponent.connectionString
            });

            appSettings.push({
                name: 'ApplicationInsightsAgent_EXTENSION_VERSION',
                value: context.newSiteOS === WebsiteOS.windows ? '~2' : '~3' // ~2 is for Windows, ~3 is for Linux
            });

            // all these settings are set on the portal if AI is enabled for Windows apps
            if (context.newSiteOS === WebsiteOS.windows) {
                appSettings.push(
                    {
                        name: 'APPINSIGHTS_PROFILERFEATURE_VERSION',
                        value: disabled
                    },
                    {
                        name: 'APPINSIGHTS_SNAPSHOTFEATURE_VERSION',
                        value: disabled
                    },
                    {
                        name: 'DiagnosticServices_EXTENSION_VERSION',
                        value: disabled
                    },
                    {
                        name: 'InstrumentationEngine_EXTENSION_VERSION',
                        value: disabled
                    },
                    {
                        name: 'SnapshotDebugger_EXTENSION_VERSION',
                        value: disabled
                    },
                    {
                        name: 'XDT_MicrosoftApplicationInsights_BaseExtensions',
                        value: disabled
                    },
                    {
                        name: 'XDT_MicrosoftApplicationInsights_Mode',
                        value: 'default'
                    });
            } else {
                appSettings.push({
                    name: 'APPLICATIONINSIGHTSAGENT_EXTENSION_ENABLED',
                    value: trueString
                });
            }
        }

        return appSettings;
    }
}
