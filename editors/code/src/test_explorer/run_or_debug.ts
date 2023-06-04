/* eslint-disable no-console */
import * as vscode from "vscode";
import * as toolchain from "../toolchain";
import { testController } from ".";
import { spawn } from "child_process";
import { assert } from "../util";
import { createArgs, prepareEnv } from "../run";
import { getRunnableByTestItem } from "./discover_and_update";
import { TestControllerHelper } from "./TestControllerHelper";
import { startDebugSession } from "../debug";
import { raContext } from "../main";
import { RustcOutputAnalyzer } from "./RustcOutputAnalyzer";
import { fail } from "assert";

export async function runHandler(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
) {
    // TODO: Never run tests concurrently in client side.

    const chosenItems = await getChosenTestItems(request);

    if (!chosenItems) {
        return;
    }

    const testRun = testController!.createTestRun(request);

    switch (request.profile?.kind) {
        case vscode.TestRunProfileKind.Debug:
            await debugChosenTestItems(chosenItems, token);
            return;
        case vscode.TestRunProfileKind.Run:
            await runChosenTestItems(chosenItems, token, testRun);
            return;
        case vscode.TestRunProfileKind.Coverage:
            await vscode.window.showErrorMessage("Not support Coverage yet");
            break;
        case undefined:
            await vscode.window.showErrorMessage("Not run from program, VSCode promise this value is existed from UI");
            break;
        default:
            fail("TS does not support type narrow well in switch, never run here");
    }
}

// const workspacesRunnable: ra.Runnable = {
//     label: 'test-mod ',
//     kind: 'cargo',
//     location: {
//         targetUri: "never_used",
//         targetRange: { start: { character: 0, line: 0 }, end: { character: 0, line: 0 } },
//         targetSelectionRange: { start: { character: 0, line: 0 }, end: { character: 0, line: 0 } },
//     },
//     args: {
//         cargoExtraArgs: [],
//         cargoArgs: [
//             "test",
//             "--workspace",
//             "--lib",
//             "--bins",
//             "--tests",
//         ],
//         executableArgs: [],
//     }
// };

async function getChosenTestItems(request: vscode.TestRunRequest) {
    if (request.include === undefined) {
        await vscode.window.showWarningMessage("Sorry, for now, one and only one test item need to be picked when using Testing Explorer powered by Rust-Analyzer");
        return undefined;//workspaceRunnable;
    }

    if (request.include.length === 0) {
        await vscode.window.showWarningMessage("There is no tests to run");
        return;
    }

    if (request.include.length !== 1) {
        await vscode.window.showWarningMessage("Sorry, for now, one and only one test item need to be picked when using Testing Explorer powered by Rust-Analyzer");
        return;
    }
    // Not handle exclude for now, because we only support one test item to run anyway.

    return request.include;
}

async function debugChosenTestItems(chosenTestItems: readonly vscode.TestItem[], _token: vscode.CancellationToken,) {
    if (!raContext) {
        return;
    }

    // TODO: add a flag to control this message, to make it less verbose.
    await vscode.window.showInformationMessage("Please note that debug will not change the state of test cases for now. Rerun them to update the state.");

    assert(chosenTestItems.length === 1, "only support 1 select test item for debugging, at least for now.");
    const runnable = getRunnableByTestItem(chosenTestItems[0]).origin;

    await startDebugSession(raContext, runnable);
}

// refer from playwright-vscode
/**
 * @param chosenTestItems The chosen ones of test items. The test cases which should be run should be the children of them.
 */
async function runChosenTestItems(chosenTestItems: readonly vscode.TestItem[], token: vscode.CancellationToken, testRun: vscode.TestRun) {
    assert(chosenTestItems.length === 1, "only support 1 select test item for running, at least for now.");
    const chosenTestItem = chosenTestItems[0];
    const runnable = getRunnableByTestItem(chosenTestItem).origin;

    const args = createArgs(runnable);

    // Remove --nocapture, so that we could analytics the output easily and always correctly.
    // Otherwise, if the case writes into stdout, due to the parallel execution,
    // the output might be messy and it might be even impossible to analytic.
    const finalArgs = args.filter(arg => arg !== '--nocapture');

    const cwd = runnable.args.workspaceRoot || ".";

    assert(finalArgs[0] === 'test', "We only support 'test' command in test explorer for now!");

    // TODO: add override cargo
    // overrideCargo: runnable.args.overrideCargo;
    const cargoPath = await toolchain.cargoPath();

    TestControllerHelper.visitTestItemTreePreOrder(testItem => {
        testRun.enqueued(testItem);
    }, chosenTestItem.children);

    // output the runned command.
    testRun.appendOutput(`${cargoPath} ${finalArgs.join(' ')}`);

    const outputAnalyzer = new RustcOutputAnalyzer(testRun, chosenTestItem);

    // start process and listen to the output
    const childProcess = spawn(cargoPath, finalArgs, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        // FIXME: Should we inheritage the runnableEnv too?
        env: prepareEnv(runnable, /* config.runnableEnv */undefined),
    });
    const stdio = childProcess.stdio;
    stdio[1].on('data', data => outputAnalyzer.onStdOut(data));
    stdio[2].on('data', data => outputAnalyzer.onStdErr(data));
    childProcess.on('exit', () => outputAnalyzer.onClose());
    token.onCancellationRequested(() => {
        console.log(`token cancelled`);
        if (!childProcess.killed) {
            childProcess.kill();
        }
        testRun.end();
    });
}
