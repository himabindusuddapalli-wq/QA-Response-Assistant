import { LightningElement, api, track } from 'lwc';
import getReviewData from '@salesforce/apex/QnaReviewController.getReviewData';
import getTeamUsersForLookup from '@salesforce/apex/QnaReviewController.getTeamUsersForLookup';
import bulkAssignQuestions from '@salesforce/apex/QnaReviewController.bulkAssignQuestions';

export default class QaAssignOwners extends LightningElement {
    _recordId;
    @api
    get recordId() { return this._recordId; }
    set recordId(value) {
        this._recordId = value;
        if (value) this._load();
    }

    @track questions = [];

    isLoading = true;
    isSaving  = false;
    errorMsg  = '';
    successMsg = '';
    documentName = '';
    bulkUserId = '';

    _teamUsers = [];

    @api invoke() {}

    get doneLoading() { return !this.isLoading; }
    get noBulkUser()  { return !this.bulkUserId; }

    get teamUserOptions() {
        return [
            { label: '— Unassigned —', value: '' },
            ...this._teamUsers.map(u => ({ label: u.name, value: u.id }))
        ];
    }

    get assignedCount() { return this.questions.filter(q => q.assignedToId).length; }
    get totalCount()    { return this.questions.length; }
    get pendingCount()  { return this.totalCount - this.assignedCount; }

    get statsText() {
        return `${this.assignedCount} of ${this.totalCount} questions have been assigned, ${this.pendingCount} are still pending.`;
    }

    get allSelected() {
        return this.questions.length > 0 && this.questions.every(q => q.selected);
    }

    get saveBtnLabel() { return this.isSaving ? 'Saving…' : 'Save assignments'; }

    _load() {
        this.isLoading = true;
        this.errorMsg  = '';
        Promise.all([
            getReviewData({ documentId: this.recordId }),
            getTeamUsersForLookup({ documentId: this.recordId })
        ])
        .then(([reviewData, teamUsers]) => {
            this.documentName = reviewData.documentName || '';
            this._teamUsers   = teamUsers || [];
            this.questions    = (reviewData.questions || []).map(q => this._enrich(q));
        })
        .catch(err => {
            this.errorMsg = err.body?.message || 'Failed to load data.';
        })
        .finally(() => { this.isLoading = false; });
    }

    _enrich(q, selected) {
        const aid = q.assignedToId || '';
        return {
            ...q,
            assignedToId:   aid,
            assignedToName: q.assignedToName || '',
            selected:       selected !== undefined ? selected : (q.selected || false),
            isAssigned:     !!aid,
            isNotAssigned:  !aid
        };
    }

    handleSelectAll(event) {
        const checked = event.target.checked;
        this.questions = this.questions.map(q => ({ ...q, selected: checked }));
    }

    handleRowSelect(event) {
        const id      = event.target.dataset.id;
        const checked = event.target.checked;
        this.questions = this.questions.map(q =>
            q.id === id ? { ...q, selected: checked } : q
        );
    }

    handleBulkUserChange(event) {
        this.bulkUserId = event.detail.value;
    }

    handleBulkApply() {
        if (!this.bulkUserId && this.bulkUserId !== '') return;
        const user = this._teamUsers.find(u => u.id === this.bulkUserId);
        this.questions = this.questions.map(q => {
            if (!q.selected) return q;
            const aid = this.bulkUserId;
            return {
                ...q,
                assignedToId:   aid,
                assignedToName: user ? user.name : '',
                isAssigned:     !!aid,
                isNotAssigned:  !aid
            };
        });
    }

    handleRowAssign(event) {
        const id     = event.currentTarget.dataset.id;
        const userId = event.detail.value || '';
        const user   = this._teamUsers.find(u => u.id === userId);
        this.questions = this.questions.map(q => {
            if (q.id !== id) return q;
            return {
                ...q,
                assignedToId:   userId,
                assignedToName: user ? user.name : '',
                isAssigned:     !!userId,
                isNotAssigned:  !userId
            };
        });
    }

    handleSave() {
        this.isSaving  = true;
        this.errorMsg  = '';
        this.successMsg = '';
        const questionIds = this.questions.map(q => q.id);
        const userIds     = this.questions.map(q => q.assignedToId || '');
        bulkAssignQuestions({ questionIds, userIds })
            .then(() => {
                this.successMsg = 'Assignments saved successfully!';
                setTimeout(() => { this.successMsg = ''; }, 3000);
            })
            .catch(err => {
                this.errorMsg = err.body?.message || 'Failed to save assignments.';
            })
            .finally(() => { this.isSaving = false; });
    }

    handleCancel() {
        this._load();
    }
}