import { LightningElement, api, track } from 'lwc';
import getDocumentTeam from '@salesforce/apex/QnaReviewController.getDocumentTeam';
import saveTeamMember from '@salesforce/apex/QnaReviewController.saveTeamMember';
import removeTeamMember from '@salesforce/apex/QnaReviewController.removeTeamMember';
import searchUsers from '@salesforce/apex/QnaReviewController.searchUsers';

export default class QaManageTeam extends LightningElement {
    _recordId;
    @api
    get recordId() { return this._recordId; }
    set recordId(value) {
        this._recordId = value;
        if (value) this._loadTeam();
    }

    @track teamMembers = [];
    @track userResults = [];
    @track selectedUser = null;

    isLoading = true;
    isAdding = false;
    showAssignStep = false;
    userSearch = '';
    role = 'Primary Owner';
    errorMsg = '';
    showNoResults = false;
    _searchTimer = null;

    @api invoke() {}

    get hasMembers() { return this.teamMembers.length > 0; }
    get noMembers()  { return !this.hasMembers; }
    get hasUserResults() { return this.userResults.length > 0; }
    get addDisabled() { return !this.selectedUser || this.isAdding; }
    get addBtnLabel() { return this.isAdding ? 'Adding…' : 'Add to Team'; }
    get doneLoading() { return !this.isLoading; }
    get noSelectedUser() { return !this.selectedUser; }
    get notAdding() { return !this.isAdding; }
    get notAssignStep() { return !this.showAssignStep; }
    get roleOptions() {
        return [
            { label: 'Primary Owner', value: 'Primary Owner' },
            { label: 'Supporting User', value: 'Supporting User' }
        ];
    }

    handleNextStep() { this.showAssignStep = true; }
    handleBackStep() { this.showAssignStep = false; }

    _loadTeam() {
        this.isLoading = true;
        this.errorMsg = '';
        getDocumentTeam({ documentId: this.recordId })
            .then(members => {
                this.teamMembers = members.map(m => ({
                    ...m,
                    initials: this._initials(m.userName),
                    roleClass: m.role === 'Primary Owner'
                        ? 'role-badge role-primary'
                        : 'role-badge role-supporting'
                }));
            })
            .catch(err => {
                this.errorMsg = err.body?.message || 'Failed to load team.';
            })
            .finally(() => { this.isLoading = false; });
    }

    _initials(name) {
        if (!name) return '?';
        const parts = name.trim().split(' ');
        return parts.length >= 2
            ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
            : name.substring(0, 2).toUpperCase();
    }

    handleUserSearch(event) {
        this.userSearch = event.target.value;
        this.showNoResults = false;
        clearTimeout(this._searchTimer);
        if (!this.userSearch || this.userSearch.length < 2) {
            this.userResults = [];
            return;
        }
        this._searchTimer = setTimeout(() => {
            searchUsers({ searchTerm: this.userSearch })
                .then(results => {
                    this.userResults = results;
                    this.showNoResults = results.length === 0;
                })
                .catch(() => { this.userResults = []; });
        }, 300);
    }

    handlePickUser(event) {
        this.selectedUser = {
            id: event.currentTarget.dataset.id,
            name: event.currentTarget.dataset.name
        };
        this.userSearch = '';
        this.userResults = [];
        this.showNoResults = false;
    }

    handleClearUser() {
        this.selectedUser = null;
        this.userSearch = '';
        this.userResults = [];
        this.showNoResults = false;
    }

    handleRoleChange(event) {
        this.role = event.detail.value;
    }

    handleAdd() {
        if (!this.selectedUser) return;
        this.errorMsg = '';
        this.isAdding = true;
        saveTeamMember({
            documentId: this.recordId,
            userId: this.selectedUser.id,
            role: this.role
        })
            .then(() => {
                this.selectedUser = null;
                this.role = 'Primary Owner';
                this._loadTeam();
            })
            .catch(err => {
                this.errorMsg = err.body?.message || 'Failed to add team member.';
            })
            .finally(() => { this.isAdding = false; });
    }

    handleRemove(event) {
        const memberId = event.currentTarget.dataset.id;
        removeTeamMember({ teamMemberId: memberId })
            .then(() => this._loadTeam())
            .catch(err => {
                this.errorMsg = err.body?.message || 'Failed to remove member.';
            });
    }
}