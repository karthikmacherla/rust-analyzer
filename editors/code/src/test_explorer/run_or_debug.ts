/* eslint-disable no-console */
import * as vscode from "vscode";
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as toolchain from "../toolchain";
import { testController } from ".";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { assert } from "../util";
import { createArgs, prepareEnv } from "../run";
import { getRunnableByTestItem } from "./discover_and_update";
import { TestItemControllerHelper } from "./TestItemControllerHelper";
import { getDebugConfiguration } from "../debug";
import { raContext } from "../main";
import { LinesRustOutputAnalyzer, PipeRustcOutputAnalyzer } from "./RustcOutputAnalyzer";
import { fail } from "assert";
import { NodeKind } from "./test_model_tree";

export async function runHandler(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
) {
    // TODO: Never run tests concurrently in client side.
    // TODO: could not run on workspace/package level, waiting for https://github.com/vadimcn/codelldb/issues/948

    const chosenItems = await getChosenTestItems(request);

    if (!chosenItems) {
        return;
    }

    const testRun = testController!.createTestRun(request);

    switch (request.profile?.kind) {
        case vscode.TestRunProfileKind.Debug:
            await debugChosenTestItems(testRun, chosenItems, token);
            return;
        case vscode.TestRunProfileKind.Run:
            await runChosenTestItems(testRun, chosenItems, token);
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

    return request.include;
}

async function debugChosenTestItems(testRun: vscode.TestRun, chosenTestItems: readonly vscode.TestItem[], token: vscode.CancellationToken) {
    if (!raContext) {
        return;
    }

    const disposables: vscode.Disposable[] = [];
    const runnables = chosenTestItems.map((chosenTestItem) => {
        return getRunnableByTestItem(chosenTestItem);
    })

    // if we're debugging multiple testItems, they must all be individual tests 
    // and from the same crate for multiple debugging to work
    const debuggingMultipleTests = chosenTestItems.length > 1
    if (chosenTestItems.length > 1) {
        const allInvididualTests = runnables.every((runnable) => runnable.testKind === NodeKind.Test)
        
        // the first runnable will serve as a template for the remaining selected tests
        const firstRunnable = runnables[0]!
        const binaryName = firstRunnable.origin.args.workspaceRoot
        const allFromSameBinary = runnables.every((runnable) => runnable.origin.args.workspaceRoot === binaryName)
        if (!allInvididualTests || !allFromSameBinary) {
            // fail here
            await vscode.window.showInformationMessage("Sorry, for now, debugging multiple tests must be from the same crate")
            return
        }
    }

    const firstRunnableOrigin =  runnables[0]!.origin
    const { debugConfig, isFromLacunchJson } = await getDebugConfiguration(raContext, firstRunnableOrigin);
        
    if (!debugConfig)
        return;

    // the trick here is to add all of the other remaining tests to the args list 
    // since they are in the same crate
    if (debuggingMultipleTests) {
        const testNameArgs = runnables.map((runnable) => runnable.origin.args.executableArgs[0]).filter((arg) => arg !== undefined)
        debugConfig['args'] = testNameArgs
        debugConfig['args'].push('--exact')
        debugConfig['args'].push('--nocapture')
    }

    if (debugConfig.type !== 'lldb') {
        await vscode.window.showInformationMessage("Sorry, for now, only [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) is supported for debugging when using Testing Explorer powered by Rust-Analyzer"
            + "You can use CodeLens to debug with [MS C++ tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)"
        );
        return;
    }

    let outputFilePath: string | undefined;

    if (isFromLacunchJson && debugConfig["stdio"]) {
        // Without `await` intentionally, because we don't want to block the UI thread.
        void vscode.window.showInformationMessage("The test choose config from launch.json and you alredy set Stdio Redirection option. We respect it but could not analytics the output.");
    } else {
        const tmpFolderPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-test-redirect-'));
        outputFilePath = path.join(tmpFolderPath, 'output.txt');
        debugConfig["stdio"] = [null, outputFilePath];
    }

    runnables.forEach((runnable, index) => {
        if (runnable.testKind === NodeKind.TestModule) {
            TestItemControllerHelper.visitTestItemTreePreOrder(testItem => {
                testRun.enqueued(testItem);
            }, chosenTestItems[index]!.children);
        } else {
            testRun.enqueued(chosenTestItems[index]!);
        }
    })

    let debugSession: vscode.DebugSession | undefined;
    disposables.push(vscode.debug.onDidStartDebugSession((session: vscode.DebugSession) => {
        // Safe, because concurrently debugging is not allowed.
        // So the name should not be duplicated
        if (session.name === debugConfig.name) {
            debugSession = session;
        }
    }));

    const success = await vscode.debug.startDebugging(undefined, debugConfig);

    if (!success || token.isCancellationRequested) {
        dispose();
        return;
    }

    token.onCancellationRequested(async () => {
        await debugSession?.customRequest('disconnect', { restart: false });
    });

    return await new Promise<void>((resolve: () => void): void => {
        disposables.push(
            vscode.debug.onDidTerminateDebugSession(async (session: vscode.DebugSession) => {
                if (debugConfig.name === session.name) {
                    debugSession = undefined;
                    if (outputFilePath) {
                        const fileLineContents = (await fs.readFile(outputFilePath, 'utf-8'))
                            .split(/\r?\n/);

                        chosenTestItems.forEach((chosenTestItem) => {
                            const outputAnalyzer = new LinesRustOutputAnalyzer(testRun, chosenTestItem);
                            outputAnalyzer.analyticsLines(fileLineContents);
                        })
                    }
                    dispose();
                    return resolve();
                }
            }),
        );
    });

    function dispose() {
        disposables.forEach(d => d.dispose());
        disposables.length = 0;
        testRun.end();
    }
}

// refer from playwright-vscode
/**
 * @param chosenTestItems The chosen ones of test items. The test cases which should be run should be the children of them.
 */
async function runChosenTestItems(testRun: vscode.TestRun, chosenTestItems: readonly vscode.TestItem[], token: vscode.CancellationToken) {
    const childProcesses: ChildProcessWithoutNullStreams[] = []
    chosenTestItems.forEach(async (chosenTestItem) => {
        const runnable = getRunnableByTestItem(chosenTestItem);
        const runnableOrigin = runnable.origin;

        const args = createArgs(runnableOrigin);

        // Remove --nocapture, so that we could analytics the output easily and always correctly.
        // Otherwise, if the case writes into stdout, due to the parallel execution,
        // the output might be messy and it might be even impossible to analytic.
        const finalArgs = args.filter(arg => arg !== '--nocapture');

        const cwd = runnableOrigin.args.workspaceRoot || ".";

        assert(finalArgs[0] === 'test', "We only support 'test' command in test explorer for now!");

        // TODO: add override cargo
        // overrideCargo: runnable.args.overrideCargo;
        const cargoPath = await toolchain.cargoPath();

        if (runnable.testKind === NodeKind.TestModule) {
            TestItemControllerHelper.visitTestItemTreePreOrder(testItem => {
                testRun.enqueued(testItem);
            }, chosenTestItem.children);
        } else {
            testRun.enqueued(chosenTestItem);
        }

        testRun.appendOutput(`${cargoPath} ${finalArgs.join(' ')}`);
        // output the runned command.

        const outputAnalyzer = new PipeRustcOutputAnalyzer(testRun, chosenTestItem);

        // start process and listen to the output
        const childProcess = spawn(cargoPath, finalArgs, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
            // FIXME: Should we inheritage the runnableEnv too?
            env: prepareEnv(runnableOrigin, /* config.runnableEnv */undefined),
        });
        childProcesses.push(childProcess)
        const stdio = childProcess.stdio;
        stdio[1].on('data', data => outputAnalyzer.onStdOut(data));
        stdio[2].on('data', data => outputAnalyzer.onStdErr(data));
        childProcess.on('exit', () => outputAnalyzer.onClose());
    })

    token.onCancellationRequested(() => {
        childProcesses.forEach((childProcess) => {
            if (!childProcess.killed) {
                childProcess.kill();
            }
        })
        testRun.end();
    });

}
