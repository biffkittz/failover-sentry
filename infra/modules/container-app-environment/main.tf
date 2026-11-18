# A Container Apps environment with only the Consumption workload profile: no fixed cost, pay per use. One per region
# (the control plane's, and one for each region of the protected workload), all logging to one workspace.
resource "azurerm_container_app_environment" "this" {
  name                       = var.name
  location                   = var.location
  resource_group_name        = var.resource_group_name
  log_analytics_workspace_id = var.log_analytics_workspace_id
  logs_destination           = "log-analytics"

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  tags = var.tags

  lifecycle {
    # Azure creates and names the infrastructure resource group of a workload-profile environment itself.
    ignore_changes = [infrastructure_resource_group_name]
  }
}
