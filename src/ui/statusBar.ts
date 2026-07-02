import * as vscode from 'vscode';

export interface StatusSummary {
  active: number;
  total: number;
  starting: boolean;
  error: boolean;
}

/** Status bar: a shield summarizing cluster state + always-visible config & log buttons. */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly configItem: vscode.StatusBarItem;
  private readonly logItem: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'ultraproxy.status';
    this.setSummary({ active: 0, total: 0, starting: false, error: false });
    this.item.show();

    this.configItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99.5);
    this.configItem.text = '$(gear)';
    this.configItem.tooltip = 'UltraProxy: Configure';
    this.configItem.command = 'ultraproxy.configure';
    this.configItem.show();

    this.logItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.logItem.text = '$(output)';
    this.logItem.tooltip = 'UltraProxy: Show Log';
    this.logItem.command = 'ultraproxy.showLog';
    this.logItem.show();
  }

  setSummary(sum: StatusSummary): void {
    const count = `${sum.active}/${sum.total}`;
    let bg: vscode.ThemeColor | undefined;
    if (sum.total === 0) {
      this.item.text = '$(shield) UltraProxy';
      this.item.tooltip = 'No clusters configured. Click to configure/apply.';
    } else if (sum.starting) {
      this.item.text = `$(sync~spin) UltraProxy ${count}`;
      this.item.tooltip = 'Connecting clusters…';
    } else if (sum.active > 0) {
      this.item.text = `$(shield) UltraProxy ${count}`;
      this.item.tooltip = `${sum.active} of ${sum.total} cluster(s) active. Click for actions.`;
    } else if (sum.error) {
      this.item.text = '$(error) UltraProxy';
      this.item.tooltip = 'A cluster failed. Click to view actions / log.';
      bg = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      this.item.text = `$(shield) UltraProxy ${count}`;
      this.item.tooltip = 'Off. Click to apply.';
    }
    this.item.backgroundColor = bg;
  }

  dispose(): void {
    this.item.dispose();
    this.configItem.dispose();
    this.logItem.dispose();
  }
}
