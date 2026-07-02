import * as vscode from 'vscode';

export async function inputSecret(prompt: string, placeHolder?: string): Promise<string | undefined> {
  return vscode.window.showInputBox({ prompt, placeHolder, password: true, ignoreFocusOut: true });
}

export async function inputText(prompt: string, value?: string, placeHolder?: string): Promise<string | undefined> {
  return vscode.window.showInputBox({ prompt, value, placeHolder, ignoreFocusOut: true });
}

export interface QuickItem<T> extends vscode.QuickPickItem {
  value: T;
}

export async function pick<T>(items: QuickItem<T>[], placeHolder: string): Promise<T | undefined> {
  const chosen = await vscode.window.showQuickPick(items, { placeHolder, ignoreFocusOut: true });
  return chosen?.value;
}
