({
    doInit: function(component, event, helper) {
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
                            window.history.back();
                        }
                    }).then(function(overlay) {
                        component.set('v.overlayRef', overlay);
                        // Attach DOM listener directly — $A.createComponent onclose binding
                        // does not reliably catch LWC custom events
                        var el = content.getElement();
                        if (el) {
                            el.addEventListener('close', function() {
                                overlay.close();
                            });
                        }
                    });
                }
            }
        );
    }
})