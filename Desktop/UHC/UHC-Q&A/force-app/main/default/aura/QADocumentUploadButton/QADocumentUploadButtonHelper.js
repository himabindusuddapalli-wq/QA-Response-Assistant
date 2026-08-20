({
    openModal: function(component, isQuickAction) {
        var navigateDocId = null;
        $A.createComponent(
            "c:qadocumentuploadmodal",
            {},
            function(content, status) {
                component.set('v.isLoading', false);
                if (status === "SUCCESS") {
                    component.find('overlayLib').showCustomModal({
                        body: content,
                        showCloseButton: false,
                        closeCallback: function() {
                            // Runs once the overlay has actually closed, whichever way it
                            // closed (our own overlay.close() call below, or the user
                            // dismissing it directly). Navigating from here — the Aura Tab's
                            // own context — rather than from inside the LWC-in-overlay avoids
                            // any question of whether the overlay panel is a proper
                            // navigation-service container.
                            if (navigateDocId) {
                                var navEvt = $A.get("e.force:navigateToSObject");
                                if (navEvt) {
                                    navEvt.setParams({ recordId: navigateDocId, slideDevName: "detail" });
                                    navEvt.fire();
                                }
                            } else if (isQuickAction) {
                                window.history.back();
                            }
                        }
                    }).then(function(overlay) {
                        component.set('v.overlayRef', overlay);
                        // Attach DOM listener directly — $A.createComponent onclose binding
                        // does not reliably catch LWC custom events
                        var el = content.getElement();
                        if (el) {
                            el.addEventListener('close', function(closeEvent) {
                                if (closeEvent.detail && closeEvent.detail.docId) {
                                    navigateDocId = closeEvent.detail.docId;
                                }
                                overlay.close();
                            });
                        }
                    });
                }
            }
        );
    }
})