# Remote state in Azure Storage. The azurerm backend takes a blob lease for every operation that can write state, so
# two people (or pipelines) can't apply at the same time. The storage account lives outside this configuration.
# State holds generated secrets (marked sensitive): treat access to the blob like access to Key Vault.
#
# Provider requirements and configuration live in providers.tf.
terraform {
  backend "azurerm" {
    resource_group_name  = "rg-terraform-state"
    storage_account_name = "demonstration"
    container_name       = "terraform"
    key                  = "temporal-node.terraform.tfstate" # Path and filename inside the container

    # Authenticate using Azure CLI credentials & Entra ID instead of Storage Keys
    #use_cli              = true
    #use_azuread_auth     = true
  }
}
