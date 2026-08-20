import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { CloseActionScreenEvent } from 'lightning/actions';
import getStats from '@salesforce/apex/QnaDownloadController.getStats';
import getStrategicInfo from '@salesforce/apex/QnaDownloadController.getStrategicInfo';
import getDraftCount from '@salesforce/apex/QnaDownloadController.getDraftCount';
import getUnansweredCount from '@salesforce/apex/QnaDownloadController.getUnansweredCount';
import getBestMatchCount from '@salesforce/apex/QnaDownloadController.getBestMatchCount';
import logDownload from '@salesforce/apex/QnaDownloadController.logDownload';

export default class QaDownloadResponse extends LightningElement {

    _recordId;
    @api
    get recordId() { return this._recordId; }
    set recordId(value) {
        if (value && !/^[a-zA-Z0-9]{15,18}$/.test(value)) return;
        this._recordId = value;
        if (value) { this.loadStats(); }
    }

    isLoading = true;
    stats;
    strategicCount = 0;        // Completed + Strategy_Applied
    strategicDraftCount = 0;   // Draft + Strategy_Applied
    draftCount = 0;
    unansweredCount = 0;
    bestMatchCount = 0;        // New questions that have a repository match

    // checkbox state
    allFinalized = true;
    allDraft = true;
    allUnanswered = true;
    stratFinalized = true;
    stratDraft = true;

    // strategic warning + workspace swap
    showStrategicWarning = false;
    showWorkspace = false;
    strategicInfo = { total: 0, completed: 0, strategic: 0, strategicDraft: 0 };
    _pendingStratCats = [];

    loadStats() {
        this.isLoading = true;
        Promise.all([
            getStats({ documentId: this._recordId }),
            getStrategicInfo({ documentId: this._recordId }),
            getDraftCount({ documentId: this._recordId }),
            getUnansweredCount({ documentId: this._recordId }),
            getBestMatchCount({ documentId: this._recordId })
        ])
            .then(([stats, strat, draftCount, unansweredCount, bestMatchCount]) => {
                this.stats = stats;
                this.strategicInfo = strat || this.strategicInfo;
                this.strategicCount = strat?.strategic ?? 0;
                this.strategicDraftCount = strat?.strategicDraft ?? 0;
                this.draftCount = draftCount ?? 0;
                this.unansweredCount = unansweredCount ?? 0;
                this.bestMatchCount = bestMatchCount ?? 0;
            })
            .catch(e => this._toast('Error', this._msg(e), 'error'))
            .finally(() => { this.isLoading = false; });
    }

    get docName() { return this.stats?.documentName || ''; }
    get fileName() { return this.stats?.fileName || ''; }
    get hasFile() { return !!this.fileName; }
    get total() { return this.stats?.total ?? 0; }
    get finalized() { return this.stats?.finalized ?? 0; }
    get pending() { return this.stats?.pending ?? 0; }

    get hasStrategic() { return (this.strategicCount ?? 0) > 0; }

    get finalizedTip() {
        const f = this.finalized;
        const s = this.strategicCount ?? 0;
        const fWord = f === 1 ? 'answer' : 'answers';
        if (s > 0) {
            return `${f} finalized ${fWord}, including ${s} with a strategy applied.`;
        }
        return `${f} finalized ${fWord}, none with a strategy applied yet.`;
    }

    // hide the download UI whenever the warning or workspace is showing
    get showDownloadView() {
        return !this.showStrategicWarning && !this.showWorkspace;
    }

    get strategicMessage() {
        const s = this.strategicInfo.strategic ?? 0;
        const base = "If you'd like to apply strategy to any of the questions, you can go back and apply it. Otherwise, you can download now.";
        if (s === 0) {
            return 'None of your questions have a strategy applied yet. ' + base;
        }
        return 'Only 1 question has a strategy applied. ' + base;
    }

    handleToggle(e) {
        const key = e.target.dataset.key;
        if (key) { this[key] = e.target.checked; }
    }

    handleCancel() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }

    // ---- All Questions card ----
    // Finalized -> Completed, Draft -> Draft, Unanswered -> New. Union of ticked boxes.
    handleDownloadAll() {
        const cats = [];
        if (this.allFinalized) cats.push('all');          // Status = Completed
        if (this.allDraft) cats.push('draft');            // Status = Draft
        if (this.allUnanswered) cats.push('unanswered');  // Status = New
        this._runDownload(cats);
    }

    // ---- Strategic card ----
    // Finalized -> Completed + Strategy_Applied ; Draft -> Draft + Strategy_Applied
    handleDownloadStrategic() {
        const cats = [];
        if (this.stratFinalized) cats.push('strategic');        // Completed + strategy
        if (this.stratDraft) cats.push('strategicdraft');       // Draft + strategy

        if (!cats.length) {
            this._toast('Nothing selected', 'Select at least one option to download.', 'warning');
            return;
        }

        // warn only when strategic-finalized is requested and 0/1 have strategy applied
        if (this.stratFinalized) {
            getStrategicInfo({ documentId: this._recordId })
                .then(info => {
                    this.strategicInfo = info || this.strategicInfo;
                    this.strategicCount = info?.strategic ?? 0;
                    this.strategicDraftCount = info?.strategicDraft ?? 0;
                    if ((info?.strategic ?? 0) <= 1) {
                        this._pendingStratCats = cats;
                        this.showStrategicWarning = true;
                    } else {
                        this._runDownload(cats);
                    }
                })
                .catch(e => this._toast('Error', this._msg(e), 'error'));
        } else {
            this._runDownload(cats);
        }
    }

    // ---- warning panel actions ----
    handleDownloadAnyway() {
        this.showStrategicWarning = false;
        const cats = this._pendingStratCats.length ? this._pendingStratCats : ['strategic'];
        this._runDownload(cats);
    }
    handleCloseWarning() {
        this.showStrategicWarning = false;
        this._pendingStratCats = [];
    }
    handleGoApplyStrategy() {
        this.showStrategicWarning = false;
        this.showWorkspace = true;
    }
    handleBackToDownload() {
        this.showWorkspace = false;
        this.loadStats();
    }

    // ---- Best-Match card: top repository match for each New question ----
    handleBestMatch() {
        if (!this._recordId) return;
        if ((this.bestMatchCount ?? 0) === 0) {
            this._toast('Nothing to download',
                'None of the unanswered questions have a repository match to pull from yet.', 'warning');
            return;
        }
        this._runDownload(['bestmatch']);
    }

    _runDownload(cats) {
        if (!this._recordId) return;
        if (!cats || !cats.length) {
            this._toast('Nothing selected', 'Select at least one option to download.', 'warning');
            return;
        }
        const count = cats.reduce((sum, c) => sum + this._countFor(c), 0);
        if (count === 0) {
            this._toast('Nothing to download', 'There are no questions matching your selection yet.', 'warning');
            return;
        }

        const category = cats.join(',');

        logDownload({ documentId: this._recordId, category, count })
            .catch(e => console.error('download log failed', this._msg(e)));

        const url = `/apex/QnaResponseDownload?id=${this._recordId}&category=${encodeURIComponent(category)}`;
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

    _countFor(c) {
        if (c === 'strategic')      return this.strategicCount ?? 0;
        if (c === 'strategicdraft') return this.strategicDraftCount ?? 0;
        if (c === 'draft')          return this.draftCount ?? 0;
        if (c === 'unanswered')     return this.unansweredCount ?? 0;
        if (c === 'bestmatch')      return this.bestMatchCount ?? 0;
        return this.finalized ?? 0; // 'all'
    }

    _toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
    _msg(e) { return e?.body?.message || e?.message || 'Something went wrong.'; }
}