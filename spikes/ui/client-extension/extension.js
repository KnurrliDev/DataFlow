// A small extension for the UI test of the layers of two clients. Its command reads a plan from the file of the
// environment variable DATAFLOW_UI_CLIENT_PLAN and shows the items of the plan with the API of DataFlow: blocks, notes,
// a detail, a guided review, and its tab in the details column. It writes the results and each click on a button of its
// items to the file of DATAFLOW_UI_CLIENT_LOG, one JSON object on each line.
const fs = require('fs');
const vscode = require('vscode');

const log = (value) => fs.appendFileSync(process.env.DATAFLOW_UI_CLIENT_LOG, `${JSON.stringify(value)}\n`);

exports.activate = (context) => {
	let api;
	let tab;
	context.subscriptions.push(vscode.commands.registerCommand('dataflowUiClient.show', async () => {
		try {
			if (!api) {
				const dataflow = vscode.extensions.getExtension('KnurrliDev.dataflow');
				api = (await dataflow.activate()).getApi(1, { client: 'ui-client' });
				context.subscriptions.push(api.onDidInvokeAction((e) => log({ click: e })));
			}
			const plan = JSON.parse(fs.readFileSync(process.env.DATAFLOW_UI_CLIENT_PLAN, 'utf8'));
			const results = {
				blocks: await api.showBlocks(plan.blocks),
				notes: await api.highlight(plan.notes),
				detail: await api.addDetail(plan.detail),
				review: await api.showReviewPlan(plan.review),
			};
			if (plan.tab) {
				if (!tab) {
					tab = api.registerTab(plan.tab.options);
					context.subscriptions.push(tab);
				}
				tab.update(plan.tab.content);
				results.tab = true;
			}
			log({ results });
		} catch (err) {
			log({ error: String(err) });
		}
	}));
};

exports.deactivate = () => undefined;
