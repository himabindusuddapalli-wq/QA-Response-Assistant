({
    doInit: function(component, event, helper) {
        // Quick Actions leave autoOpen at its default (true) so the modal opens the
        // instant this component inits — that init IS the click handler for a Quick
        // Action. When this same component is dropped directly onto a Lightning Record
        // Page (e.g. the Q&A Document page), an admin sets autoOpen=false in App Builder;
        // otherwise every visit to that page would auto-reopen the modal, since a page
        // component inits on every page load rather than on a user click.
        if (component.get('v.autoOpen')) {
            component.set('v.isLoading', true);
            helper.openModal(component, true);
        }
    },

    handleUploadClick: function(component, event, helper) {
        component.set('v.isLoading', true);
        helper.openModal(component, false);
    }
})