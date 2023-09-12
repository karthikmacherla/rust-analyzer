import * as vscode from "vscode";
import { assert, assertNever } from "../util";
import { getTestItemByTestLikeNode, getTestModelByTestItem } from "./discover_and_update";
import {
    type CargoPackageNode,
    DummyRootNode,
    NodeKind,
    type TargetNode,
    type TestModuleNode,
    type TestNode,
    getPackageNodeOfTestModelNode,
} from "./test_model_tree";
import { sep } from 'node:path';

const targetPatternNamedCaptureGroup = {
    /**
     * .e.g, 'src/lib.rs', seprator is os-sensitive
     */
    relativePath: 'relativePath',
    /**
     * normarlized target name, '-' is relaced by '_'
     *
     * please refer https://www.reddit.com/r/rust/comments/8sezkm/where_are_the_rules_for_creating_valid_rust
     */
    normalizedTargetName: 'normalizedTargetName',
} as const;

const sepInRegexString = sep === '\\' ? '\\\\' : sep;
// when target is lib/bin, there is "unittests ", when target is integration test, there is not
const targetPattern = new RegExp(`Running (?:unittests )?(?<${targetPatternNamedCaptureGroup.relativePath}>.*?) \(.*${sepInRegexString}(?<${targetPatternNamedCaptureGroup.normalizedTargetName}>.*?)-.*?\)`);

const caseResultPattern = /^test (.*?) ... (\w*)$/;
const stacktraceTestCasePattern = /^---- (.*?) stdout ----$/;
const stacktraceStartPattern = /^failures:$/;
// Although it is the same as start pattern in the output of rustc now,
// we means the end of the stack trace part.
const stacktraceEndPattern = /^failures:$/;

abstract class RustcOutputAnalyzer {
    private _testItemLocator: TestItemLocator;
    protected _testRun: vscode.TestRun;
    constructor(
         testRun: vscode.TestRun,
        testItem: vscode.TestItem,
    ) {
        this._testRun = testRun;
        this._testItemLocator = new TestItemLocator(testItem);
    }

    private _currentNormalizedTargetName: string | undefined = undefined;
    private _currentTargetRelativePath: string | undefined = undefined;

    protected analyticsCurrentTestTarget(line: string) {
        const match = targetPattern.exec(line); // Running unittests src\\lib.rs (target\\debug\\deps\\hashbrown-3547e1bc587fc63a.exe)
        if (match) {
            this._currentNormalizedTargetName = match?.groups?.[targetPatternNamedCaptureGroup.normalizedTargetName];
            this._currentTargetRelativePath = match?.groups?.[targetPatternNamedCaptureGroup.relativePath];
        }
    }

    protected analyticsTestCaseResult(line: string) {
        const match = caseResultPattern.exec(line);
        const rustcCasePath = match?.[1];
        const rustcTestResultString = match?.[2];
        if (rustcCasePath && rustcTestResultString) {
            const rustcTestResult = RustcTestResult.parse(rustcTestResultString);
            const testItem = this._testItemLocator.findTestItemByRustcOutputCasePath(
                this._currentNormalizedTargetName!,
                this._currentTargetRelativePath!,
                rustcCasePath);
            if (!testItem) { return; }
            // TODO: time is only avaliable in nightly, should we support it?
            switch (rustcTestResult) {
                case RustcTestResult.passed:
                    this._testRun.passed(testItem);
                    break;
                case RustcTestResult.failed:
                    // Mark test item failed
                    // The error message is added later, in `analyticsStackTrace`
                    this._testRun.failed(testItem, []);
                    break;
                case RustcTestResult.ignored:
                    this._testRun.skipped(testItem);
                    break;
                default:
                    assertNever(rustcTestResult);
            }
        }
    }


    // At the end of the output, when the tests are all finished
    // stack trace(if any failed) will be output together in a big `data`
    // set this flag to analytics all the output
    private _failureContextAnalyticsFlag = false;
    private _currentFailedRustcOutputTest: vscode.TestItem | undefined = undefined;
    private _currentFailedCaseOutputWithStackTrace: string[] = [];

    protected analyticsStackTrace(line: string) {
        if (!this._failureContextAnalyticsFlag && stacktraceStartPattern.test(line)) {
            this._failureContextAnalyticsFlag = true;
            return;
        }

        if (this._failureContextAnalyticsFlag && stacktraceEndPattern.test(line)) {
            this._failureContextAnalyticsFlag = false;
            this.flushStackTraceAnalytics();
            return;
        }

        if (this._failureContextAnalyticsFlag) {
            const match = stacktraceTestCasePattern.exec(line);
            const rustcCasePath = match?.[1];

            if (rustcCasePath) {
                const testItem = this._testItemLocator.findTestItemByRustcOutputCasePath(
                    this._currentNormalizedTargetName!,
                    this._currentTargetRelativePath!,
                    rustcCasePath);

                if (!testItem) { assert(false, "Should never happened. Could not bear this error."); }
                this.flushStackTraceAnalytics();
                this._currentFailedRustcOutputTest = testItem;
            }

            this._currentFailedCaseOutputWithStackTrace.push(line);
        }
    }

    protected flushStackTraceAnalytics() {
        if (this._currentFailedRustcOutputTest) {
            this._testRun.failed(this._currentFailedRustcOutputTest, new vscode.TestMessage(this._currentFailedCaseOutputWithStackTrace.join('\n')));
        }
        this._currentFailedCaseOutputWithStackTrace = [];
    }
}

// why replace: refer https://code.visualstudio.com/api/extension-guides/testing#test-output
function normalizeOutputData(data: any): string {
    return data.toString().replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

enum RustcTestResult {
    passed,
    failed,
    ignored,
}

namespace RustcTestResult {
    export function parse(rustcResultString: string) {
        switch (rustcResultString) {
            case 'ok':
                return RustcTestResult.passed;
            case 'ignored':
                return RustcTestResult.ignored;
            case 'FAILED':
                return RustcTestResult.failed;
            default:
                assert(false, "What should we do if this is changed? Throw error?");
        }
    }
}

class TestItemLocator {
    private readonly _testModel: CargoPackageNode | TargetNode | TestModuleNode | TestNode;

    // We only allow one test case to be runned
    constructor(chosenRunnedTestItem: vscode.TestItem) {
        const node = getTestModelByTestItem(chosenRunnedTestItem);

        assert(node.kind === NodeKind.Test
            || node.kind === NodeKind.TestModule
            || node.kind === NodeKind.Target
            || node.kind === NodeKind.CargoPackage,
            "does not support workspace level, until we allow try to guess the target"
        );

        this._testModel = node;
    }

    /**
     * @param path This is the path which is shown on the output of test result, like mod1::mod2::mod3::test1
     */
    findTestItemByRustcOutputCasePath(packageNormalizedName: string, targetRelativePath: string, path: string): vscode.TestItem | undefined {
        // const workspaceRootNode = getWorkspaceNodeOfTestModelNode(this._testModel);
        let targetNode = tryGetTargetNodeOfTestModelNode(this._testModel);

        if (!targetNode) {
            const packageNode = getPackageNodeOfTestModelNode(this._testModel);

            const targetCandidates =
                // workspaceRootNode.members
                // .flatMap(packageNode => Array.from(packageNode.targets))
                Array.from(packageNode.targets)
                .filter(target =>
                    normalizeTargetName(target.name) === packageNormalizedName
                    && target.srcPath.fsPath.includes(targetRelativePath)
                );

            assert(targetCandidates.length === 1, "should find one and only one target node, but they might have same name and relative path, although it should be really rare");
            // REVIEW: What should we do if we found 2 or more candidates?
            targetNode = targetCandidates[0]!; // safe, we have checked the length
        }

        const testNode = DummyRootNode.instance.findTestLikeNodeUnderTarget(
            targetNode,
            NodeKind.Test,
            path.split('::')
        );

        const candidate = getTestItemByTestLikeNode(testNode);

        return candidate;

        function tryGetTargetNodeOfTestModelNode(testModel: TestModuleNode | TargetNode | TestNode | CargoPackageNode) {
            if (testModel.kind === NodeKind.CargoPackage) return undefined;
            while (testModel.kind !== NodeKind.Target) {
                testModel = testModel.parent;
            }
            return testModel;
        }

    }
}

function normalizeTargetName(packageName: string) {
    return packageName.replace(/-/g, '_');
}

/**
 * This analyzer analytics the output of Rustc, it assumes the output is line by line(No CR/LF, each line is a string)
 */
export class LinesRustOutputAnalyzer extends RustcOutputAnalyzer {
    constructor(
        testRun: vscode.TestRun,
        testItem: vscode.TestItem,
    ) {
        super(testRun,testItem);
    }

    public analyticsLines(lines:string[]) {
        lines.forEach(line => {
            this._testRun.appendOutput(line + '\r\n');
            this.analyticsCurrentTestTarget(line);
            this.analyticsTestCaseResult(line);
            this.analyticsStackTrace(line);
        });
        this._testRun.end();
     }
}

export class PipeRustcOutputAnalyzer extends RustcOutputAnalyzer {
    constructor(
        testRun: vscode.TestRun,
        testItem: vscode.TestItem,
    ) {
        super(testRun,testItem);
    }

    public onStdErr(data: any) {
        // This is so weird, some messages will be logged as stderr
        // like "Finished test [unoptimized + debuginfo] target(s) in 0.07s"
        // and "Running unittests src\lib.rs (target\debug\deps\hashbrown-3547e1bc587fc63a.exe)"

        // And this make it hard to use breakpoint to debug, because the buffer will be flushed in unexpected order.
        const normalizedData = normalizeOutputData(data);

        this._testRun.appendOutput(normalizedData);

        const lines = normalizedData.split("\r\n");

        lines.forEach(line => {
            this.analyticsCurrentTestTarget(line);
        });
    }

    public onClose() {
        this._testRun.end();
    }

    public onStdOut(data: any) {
        // It seems like the data will be end with a line breaking. Is this promised?
        const normalizedData = normalizeOutputData(data);

        this._testRun.appendOutput(normalizedData);

        const lines = normalizedData.split("\r\n");

        lines.forEach(line => {
            this.analyticsTestCaseResult(line);
            this.analyticsStackTrace(line);
        });
    }
}
