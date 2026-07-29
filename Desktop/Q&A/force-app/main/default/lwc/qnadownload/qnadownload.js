import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getStats from '@salesforce/apex/QnaDownloadController.getStats';
import stampCustomEdits from '@salesforce/apex/QnaDownloadController.stampCustomEdits';
import getStrategicInfo from '@salesforce/apex/QnaDownloadController.getStrategicInfo';
import getCustomCount from '@salesforce/apex/QnaDownloadController.getCustomCount';
import getDraftCount from '@salesforce/apex/QnaDownloadController.getDraftCount';


export default class QaDownloadResponse extends LightningElement {

    _recordId;
    @api
    get recordId() { return this._recordId; }
    set recordId(value) {
        this._recordId = value;
        if (value) { this.loadStats(); }
    }

    isLoading = true;
    stats;

    // extra metrics
    strategicCount = 0;
    draftCount = 0;

    // selected download category (radio)
    selectedCategory = 'all';

    // strategic warning panel
    showStrategicWarning = false;
    strategicInfo = { total: 0, completed: 0, strategic: 0 };

    // review workspace swap
    showWorkspace = false;

    loadStats() {
        this.isLoading = true;
        Promise.all([
            getStats({ documentId: this._recordId }),
            getStrategicInfo({ documentId: this._recordId }),
            getDraftCount({ documentId: this._recordId })
        ])
            .then(([stats, strat, draftCount]) => {
                this.stats = stats;
                this.strategicInfo = strat || { total: 0, completed: 0, strategic: 0 };
                this.strategicCount = strat?.strategic ?? 0;
                this.draftCount = draftCount ?? 0;
            })
            .catch(e => this._toast('Error', this._msg(e), 'error'))
            .finally(() => { this.isLoading = false; });
    }

    get docName() { return this.stats?.documentName || ''; }
    get rfpName() { return this.stats?.rfpName || ''; }
    get total() { return this.stats?.total ?? 0; }
    get finalized() { return this.stats?.finalized ?? 0; }
    get pending() { return this.stats?.pending ?? 0; }
    get hasRfp() { return !!this.rfpName; }

    // ---- radio selection ----
    get isAll() { return this.selectedCategory === 'all'; }
    get isStrategic() { return this.selectedCategory === 'strategic'; }
    get isDraft() { return this.selectedCategory === 'draft'; }
    get classAll() { return 'qa-radio' + (this.isAll ? ' qa-radio--sel' : ''); }
    get classStrategic() { return 'qa-radio' + (this.isStrategic ? ' qa-radio--sel' : ''); }
    get classDraft() { return 'qa-radio' + (this.isDraft ? ' qa-radio--sel' : ''); }

   get downloadLabel() {
        return 'Download';
    }
    handleRadioChange(e) {
        this.selectedCategory = e.target.value;
    }
    get hasStrategic() { return this.strategicCount > 0; }

    get finalizedTip() {
        const f = this.finalized;
        const s = this.strategicCount;
        const fWord = f === 1 ? 'answer' : 'answers';
        if (s > 0) {
            return `${f} finalized ${fWord}, including ${s} with a strategy applied.`;
        }
        return `${f} finalized ${fWord}, none with a strategy applied yet.`;
    }

    // hide the download UI whenever a panel/workspace is showing
    get showDownloadView() {
        return !this.showStrategicWarning && !this.showWorkspace;
    }
    get strategicMessage() {
        const s = this.strategicInfo.strategic ?? 0;
        const base = "If you'd like to apply strategy to any of the questions, you can go back and apply it. Otherwise, you can download now.";
        if (s === 0) {
            return "None of your questions have a strategy applied yet. " + base;
        }
        return "Only 1 question has a strategy applied. " + base;
    }

    // ---- single download entry point (routes by selected radio) ----
    handleDownload() {
        switch (this.selectedCategory) {
            case 'strategic':
                this.handleDownloadStrategic();
                break;
            case 'draft':
                this.handleDownloadDrafts();
                break;
            default:
                this.handleDownloadAll();
        }
    }

    // ---- Cancel: close the modal (launcher/quick action listens for 'close') ----
    handleCancel() {
        this.dispatchEvent(new CustomEvent('close'));
    }

    // ---- All Finalized ----
    handleDownloadAll() {
        if (this.finalized === 0) {
            this._toast('Nothing to download', 'There are no finalized questions and answers to download yet.', 'warning');
            return;
        }
        this._download('all');
    }

    // ---- Strategic: count first, warn if 0 or 1, else download ----
    handleDownloadStrategic() {
        if (!this._recordId) return;
        getStrategicInfo({ documentId: this._recordId })
            .then(info => {
                this.strategicInfo = info;
                if ((info.strategic ?? 0) <= 1) {
                    this.showStrategicWarning = true;
                } else {
                    this._download('strategic');
                }
            })
            .catch(e => this._toast('Error', this._msg(e), 'error'));
    }

    // ---- Custom Edited (retained for later; not in UI for now) ----
    handleDownloadCustom() {
        if (!this._recordId) return;
        getCustomCount({ documentId: this._recordId })
            .then(count => {
                if (count === 0) {
                    this._toast('Nothing to download', 'There are no custom-edited questions and answers to download yet.', 'warning');
                    return;
                }
                return stampCustomEdits({ documentId: this._recordId })
                    .then(() => this._download('custom'));
            })
            .catch(e => this._toast('Error', this._msg(e), 'error'));
    }

    // ---- Drafted Questions ----
    handleDownloadDrafts() {
        if (!this._recordId) return;
        getDraftCount({ documentId: this._recordId })
            .then(count => {
                if (count === 0) {
                    this._toast('Nothing to download', 'There are no drafted questions to download yet.', 'warning');
                    return;
                }
                this._download('draft');
            })
            .catch(e => this._toast('Error', this._msg(e), 'error'));
    }

    // warning panel actions
    handleDownloadAnyway() {
        this.showStrategicWarning = false;
        this._download('strategic');
    }
    handleCloseWarning() {
        this.showStrategicWarning = false;
    }
    handleGoApplyStrategy() {
        this.showStrategicWarning = false;
        this.showWorkspace = true;        // swap to the review workspace
    }
    handleBackToDownload() {
        this.showWorkspace = false;       // return to the download view
    }

    _download(category) {
        if (!this._recordId) return;

        const url = `/apex/QnaResponseDownload?id=${this._recordId}&category=${category}`;

        let frame = this.template.querySelector('iframe.qa-dl-frame');
        if (!frame) {
            frame = document.createElement('iframe');
            frame.className = 'qa-dl-frame';
            frame.style.display = 'none';
            this.template.querySelector('.qa-panel').appendChild(frame);
        }
        frame.src = url;

        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => {
            this._toast('Download Successful', 'Your Q&A document has been downloaded.', 'success');
        }, 1200);
    }

    _toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
    _msg(e) {
        return e?.body?.message || e?.message || 'Something went wrong.';
    }
}